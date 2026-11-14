import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { defaults, validateConfig } from '../src/config.ts';
import { HttpProvider, ProviderFailure } from '../src/provider.ts';
import { PuppyAgent } from '../src/agent.ts';
import { estimateUsd, metricsFromResponse, normalizeUsage, summarizeUsage } from '../src/usage.ts';
import type { Block, Completion, CompletionRequest, JsonObject, Provider, ProviderConfig } from '../src/types.ts';

const base = process.env.PUPPY_TEST_TMP;
if (!base) throw new Error('Set PUPPY_TEST_TMP explicitly.');
const providerConfig: ProviderConfig = { protocol: 'anthropic', auth: 'none', apiKeyEnv: '', baseUrl: 'https://example.com/v1', model: 'claude-opus-5-5', stream: true };
const tool = (id: string, name: string, input: JsonObject): Block => ({ type: 'tool_use', id, name, input });
const rawUsage = { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 }, output_tokens: 20 };
function completion(content: Block[], credits?: number): Completion {
  const metrics = metricsFromResponse({ usage: rawUsage, id: 'msg-test', model: 'claude-opus-5-5', ...(credits === undefined ? {} : { credits_consumed: credits }) }, 'anthropic', 'claude-opus-5-5', 15, false);
  return { message: { role: 'assistant', content }, inputTokens: 350, outputTokens: 20, stopReason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', metrics };
}
const fake = (complete: Provider['complete']): Provider => ({ complete, models: async () => ['claude-opus-5-5'] });
async function fixture(limit = 1) {
  await mkdir(base!, { recursive: true });
  const root = await mkdtemp(join(base!, 'billing-'));
  const workspace = join(root, 'workspace'), tmpDir = join(root, 'tmp');
  await mkdir(workspace); await mkdir(tmpDir);
  const store = new Store(join(root, 'sessions.sqlite'));
  const config = validateConfig({ ...defaults, tmpDir, dataDir: join(root, 'data'), provider: 'test', providers: { test: { ...providerConfig, maxTaskCredits: limit } } });
  const session = store.create({ cwd: workspace, provider: 'test', model: providerConfig.model, permissionMode: 'workspace-write' });
  return { root, workspace, tmpDir, store, config, session, async cleanup() { store.close(); await rm(root, { recursive: true, force: true }); } };
}
function event(type: string, rest: JsonObject = {}) { return { type, ...rest }; }
function stream(events: JsonObject[], bytes = 7): Response {
  const wire = new TextEncoder().encode(events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < wire.length; i += bytes) controller.enqueue(wire.slice(i, i + bytes)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
function frames(): JsonObject[] {
  return [
    event('message_start', { message: { role: 'assistant', id: 'stream-id', model: 'claude-opus-5-5', content: [], usage: { ...rawUsage, output_tokens: 0 } } }),
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Привет ' } }),
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'мир' } }),
    event('content_block_stop', { index: 0 }),
    event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call-id', name: 'read_file', input: {} } }),
    event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
    event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"hello.txt"}' } }),
    event('content_block_stop', { index: 1 }),
    event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 33 }, credits_consumed: 0.28 }),
    event('message_stop'),
  ];
}

test('Anthropic and OpenAI cache counters use their different input-token semantics', () => {
  const anth = normalizeUsage(rawUsage, 'anthropic');
  assert.equal(anth.inputTokens, 350);
  assert.equal(anth.uncachedInputTokens, 100);
  assert.equal(anth.cacheReadInputTokens, 200);
  const openai = normalizeUsage({ prompt_tokens: 350, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens: 20 }, 'openai-chat');
  assert.equal(openai.inputTokens, 350); // Cached tokens are already included in prompt_tokens.
  assert.equal(openai.uncachedInputTokens, 150);
  assert.equal(normalizeUsage({}, 'anthropic').cacheReadInputTokens, null);
  assert.equal(normalizeUsage({ input_tokens: 100 }, 'anthropic').inputTokens, null);
  assert.equal(metricsFromResponse({ credits_consumed: 0 }, 'anthropic', 'm', 0, false).creditsConsumed, 0);
  assert.equal(metricsFromResponse({ credits_consumed: -1 }, 'anthropic', 'm', 0, false).creditsConsumed, null);
});

test('USD estimates price each cache tier once and remain unknown without complete rates or cache data', () => {
  const usage = normalizeUsage({ input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 150, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 } }, 'anthropic');
  const pricing = { inputUsdPerMTok: 4, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 0.2, cacheWrite5mUsdPerMTok: 5, cacheWrite1hUsdPerMTok: 8 };
  assert.ok(Math.abs(estimateUsd(usage, pricing)! - 0.0073) < 1e-10);
  assert.equal(estimateUsd(usage, { inputUsdPerMTok: 4 }), null);
  assert.equal(estimateUsd({ ...usage, cacheWrite1hInputTokens: null }, pricing), null);
  assert.equal(estimateUsd(usage), null);
});

test('SSE handles fragmented UTF-8, tool JSON and final billing without double-counting cumulative usage', async () => {
  const deltas: string[] = [];
  const provider = new HttpProvider({ ...providerConfig, promptCache: '5m' }, 3000, async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    assert.equal(request.stream, true);
    assert.deepEqual(request.cache_control, { type: 'ephemeral', ttl: '5m' });
    return stream(frames());
  });
  const response = await provider.complete({ system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [], maxTokens: 100, onTextDelta: t => deltas.push(t) });
  assert.equal(deltas.join(''), 'Привет мир');
  assert.deepEqual(response.message.content[1], tool('call-id', 'read_file', { path: 'hello.txt' }));
  assert.equal(response.metrics!.usage.outputTokens, 33);
  assert.equal(response.inputTokens, 350);
  assert.equal(response.metrics!.creditsConsumed, 0.28);
  assert.equal(response.metrics!.responseId, 'stream-id');
  assert.equal(response.metrics!.streamed, true);
});

test('models use the separately configured discovery endpoint', async () => {
  const provider = new HttpProvider({ ...providerConfig, modelsUrl: 'https://example.com/anthropic/v1/models' }, 1000, async url => {
    assert.equal(url, 'https://example.com/anthropic/v1/models');
    return Response.json({ data: [{ id: 'claude-opus-5-5' }] });
  });
  assert.deepEqual(await provider.models(), ['claude-opus-5-5']);
});

test('multiple streamed text blocks preserve initial text and paragraph separators for terminal rendering', async () => {
  let streamed = '';
  const events = [
    event('message_start', { message: { role: 'assistant', content: [], usage: rawUsage } }),
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '# Hello' } }),
    event('content_block_stop', { index: 0 }),
    event('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '**World**' } }),
    event('content_block_stop', { index: 1 }),
    event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }),
    event('message_stop'),
  ];
  const provider = new HttpProvider(providerConfig, 1000, async () => stream(events));
  const response = await provider.complete({ system: 's', messages: [], tools: [], maxTokens: 100, onTextDelta: text => { streamed += text; } });
  const finalText = response.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  assert.equal(streamed, '# Hello\n**World**');
  assert.equal(streamed, finalText);
});

test('a truncated stream rejects partial tools and retains observed usage and billing', async () => {
  const provider = new HttpProvider(providerConfig, 3000, async () => stream(frames().slice(0, -1)));
  await assert.rejects(provider.complete({ system: 's', messages: [], tools: [], maxTokens: 10 }), error => {
    assert.ok(error instanceof ProviderFailure);
    assert.match(error.message, /Incomplete provider stream/);
    assert.equal(error.metrics.creditsConsumed, 0.28);
    assert.equal(error.metrics.usage.outputTokens, 33);
    return true;
  });
});

test('task credit limit stops further calls and unexecuted tools; /continue retains the same spend', async () => {
  const f = await fixture(0.5);
  try {
    let calls = 0;
    const provider = fake(async () => {
      calls++;
      return completion([tool(String(calls), 'write_file', { path: `file-${calls}.txt`, content: 'hello' })], calls === 1 ? 0.2 : 0.3);
    });
    const options = { config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => provider };
    const agent = new PuppyAgent(options);
    await assert.rejects(agent.run(f.session.id, 'work'), /credit limit reached/);
    assert.equal(calls, 2);
    assert.ok((await stat(join(f.workspace, 'file-1.txt'))).isFile());
    await assert.rejects(stat(join(f.workspace, 'file-2.txt')), /ENOENT/);
    const task = f.store.latestTask(f.session.id)!;
    const restored = new PuppyAgent(options);
    await assert.rejects(restored.run(f.session.id, 'continue', true), /credit limit reached/);
    assert.equal(restored.runId, task.id);
    assert.equal(calls, 2);
    const report = summarizeUsage(f.store.requests(f.session.id));
    assert.equal(report.credits.reported, 0.5);
    assert.equal(report.credits.requestsUnknown, 0);
  } finally { await f.cleanup(); }
});

test('missing credits stop a limited task before file mutations and remain unknown in the report', async () => {
  const f = await fixture();
  try {
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false,
      providerFactory: () => fake(async () => completion([tool('a', 'write_file', { path: 'should-not-exist.txt', content: 'no' })])) });
    await assert.rejects(agent.run(f.session.id, 'work'), /unknown billing/);
    await assert.rejects(stat(join(f.workspace, 'should-not-exist.txt')), /ENOENT/);
    const report = summarizeUsage(f.store.requests(f.session.id));
    assert.equal(report.credits.requestsUnknown, 1);
    assert.equal(report.estimatedTokenUsd.requestsUnknown, 1);
  } finally { await f.cleanup(); }
});

test('parent and helpers share the same persisted task credit limit', async () => {
  const f = await fixture(1);
  try {
    let rootCalls = 0, childCalls = 0;
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false,
      providerFactory: session => fake(async () => {
        if (session.parentId) { childCalls++; return completion([{ type: 'text', text: 'helper done' }], 0.6); }
        rootCalls++;
        return rootCalls === 1
          ? completion([tool('spawn', 'spawn_puppy', { task: 'inspect', name: 'Scout' })], 0.2)
          : completion([tool('list', 'list_files', { path: '.' })], 0.3);
      }),
    });
    await assert.rejects(agent.run(f.session.id, 'delegate'), /credit limit reached/);
    assert.equal(rootCalls, 2); assert.equal(childCalls, 1);
    const records = f.store.requests(f.session.id);
    assert.equal(new Set(records.map(r => r.runId)).size, 1);
    assert.equal(records.length, 3);
    assert.ok(Math.abs(summarizeUsage(records).credits.reported - 1.1) < 1e-10);
  } finally { await f.cleanup(); }
});

test('an in-flight request left by a crash is unknown billing and cannot silently reset a budget', async () => {
  const f = await fixture();
  try {
    const task = f.store.startTask(f.session.id, 1);
    f.store.startRequest(task.id, f.session, 'agent');
    let called = false;
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false,
      providerFactory: () => fake(async () => { called = true; return completion([{ type: 'text', text: 'done' }], 0); }) });
    await assert.rejects(agent.run(f.session.id, 'continue', true), /unknown billing/);
    assert.equal(called, false);
    const report = summarizeUsage(f.store.requests(f.session.id));
    assert.equal(report.pending, 1); assert.equal(report.credits.requestsUnknown, 1);
  } finally { await f.cleanup(); }
});

test('failed streams persist billing evidence, and price snapshots survive settings changes', async () => {
  const f = await fixture();
  try {
    f.config.providers.test.pricing = { inputUsdPerMTok: 4, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 0.2, cacheWrite5mUsdPerMTok: 5, cacheWrite1hUsdPerMTok: 8, usdPerCredit: 0.005 };
    const provider = new HttpProvider(providerConfig, 1000, async () => stream(frames().slice(0, -1)));
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => provider });
    await assert.rejects(agent.run(f.session.id, 'work'), /Incomplete provider stream/);
    f.config.providers.test.pricing.inputUsdPerMTok = 100;
    const records = f.store.requests(f.session.id);
    assert.equal(records[0].status, 'failed');
    assert.equal(records[0].metrics!.creditsConsumed, 0.28);
    assert.equal(records[0].pricing!.inputUsdPerMTok, 4);
    const summary = summarizeUsage(records);
    assert.ok(Math.abs(summary.creditsUsdAtConfiguredRate.reported - 0.0014) < 1e-10);
    assert.equal(summary.failed, 1);
  } finally { await f.cleanup(); }
});
