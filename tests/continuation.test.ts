import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaults, validateConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { PuppyAgent } from '../src/agent.ts';
import { HttpProvider } from '../src/provider.ts';
import { metricsFromResponse } from '../src/usage.ts';
import type { Block, Completion, CompletionRequest, Provider } from '../src/types.ts';

const base = process.env.PUPPY_TEST_TMP;
if (!base) throw new Error('Set PUPPY_TEST_TMP explicitly.');
async function fixture() {
  await mkdir(base!, { recursive: true });
  const root = await mkdtemp(join(base!, 'continuation-'));
  const workspace = join(root, 'workspace'), tmpDir = join(root, 'tmp');
  await mkdir(workspace); await mkdir(tmpDir);
  const config = validateConfig({ ...defaults, provider: 'test', tmpDir, dataDir: root, maxPackCalls: 5, providers: { test: { protocol: 'anthropic', baseUrl: 'https://example.com/v1', auth: 'none', apiKeyEnv: '', model: 'test', maxTaskCredits: 1 } } });
  const store = new Store(join(root, 'sessions.sqlite'));
  const session = store.create({ cwd: workspace, provider: 'test', model: 'test', permissionMode: 'workspace-write' });
  return { root, workspace, tmpDir, config, store, session, async cleanup() { store.close(); await rm(root, { recursive: true, force: true }); } };
}
function reply(content: Block[], stopReason = 'end_turn'): Completion {
  return { message: { role: 'assistant', content }, inputTokens: 10, outputTokens: 10, stopReason, metrics: metricsFromResponse({ usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, credits_consumed: 0.1 }, 'anthropic', 'test', 1, false) };
}
const text = (value: string, stop = 'end_turn') => reply([{ type: 'text', text: value }], stop);
const fake = (complete: Provider['complete']): Provider => ({ complete, models: async () => ['test'] });

test('truncated complete responses never run their tools and continue within the same task budget', async () => {
  const f = await fixture(); let count = 0;
  try {
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => fake(async req => {
      count++;
      if (count === 1) return reply([{ type: 'tool_use', id: 'partial', name: 'write_file', input: { path: 'unsafe.txt', content: 'must never run' } }], 'max_tokens');
      if (count === 2) {
        await assert.rejects(stat(join(f.workspace, 'unsafe.txt')), { code: 'ENOENT' });
        assert.ok(req.messages.some(m => m.content.some(b => b.type === 'tool_result' && b.tool_use_id === 'partial' && b.is_error && b.content.includes('Not executed'))));
        return reply([{ type: 'tool_use', id: 'fresh', name: 'write_file', input: { path: 'safe.txt', content: 'complete operation' } }], 'tool_use');
      }
      return text('verified');
    }) });
    assert.equal(await agent.run(f.session.id, 'Write a file'), 'verified');
    assert.equal(await readFile(join(f.workspace, 'safe.txt'), 'utf8'), 'complete operation');
    await assert.rejects(stat(join(f.workspace, 'unsafe.txt')), { code: 'ENOENT' });
    const rows = f.store.requests(f.session.id);
    assert.equal(rows.length, 3); assert.equal(new Set(rows.map(r => r.runId)).size, 1);
    assert.equal(rows[0].metrics?.stopReason, 'max_tokens');
    assert.equal(rows[0].metrics?.requestedMaxOutputTokens, f.config.maxOutputTokens);
    assert.equal(agent.callsRemaining, 2);
  } finally { await f.cleanup(); }
});

test('automatic continuation is bounded and manual continuation retains consumed calls and credits', async () => {
  const f = await fixture();
  try {
    const first = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => fake(async () => text('partial', 'max_tokens')) });
    await assert.rejects(first.run(f.session.id, 'Long task'), /repeatedly/);
    const task = f.store.latestTask(f.session.id)!;
    assert.equal(f.store.requests(f.session.id).length, 3);
    const next = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => fake(async () => text('done')) });
    await next.run(f.session.id, 'Continue the same task', true);
    assert.equal(next.runId, task.id); assert.equal(next.callsRemaining, 1);
    assert.ok(Math.abs(next.creditsConsumed - 0.4) < 1e-9);
  } finally { await f.cleanup(); }
});

test('summary retry commits only a complete checkpoint and reuses the unfinished task allowance', async () => {
  const f = await fixture(); let attempts = 0;
  try {
    for (let i = 0; i < 8; i++) { f.store.append(f.session.id, { role: 'user', content: [{ type: 'text', text: `task ${i}` }] }); f.store.append(f.session.id, text(`answer ${i}`).message); }
    const original = f.store.messages(f.session.id);
    const task = f.store.startTask(f.session.id, 1);
    const id = f.store.startRequest(task.id, f.session, 'agent');
    f.store.finishRequest(id, reply([]).metrics!, 'failed'); f.store.finishTask(task.id, 'failed');
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false });
    await agent.compact(f.store.get(f.session.id), fake(async req => {
      attempts++; assert.equal(req.tools.length, 0); assert.equal(req.maxTokens, f.config.compactionMaxOutputTokens);
      assert.equal(f.store.get(f.session.id).summary, '', 'no truncated checkpoint was committed');
      return attempts === 1 ? text('partial checkpoint', 'max_tokens') : reply([{ type: 'thinking', thinking: 'Summarizing.', signature: 'signature' }, { type: 'text', text: 'Concise complete checkpoint' }]);
    }), true);
    assert.equal(attempts, 2); assert.equal(agent.runId, task.id); assert.equal(agent.callsRemaining, 2);
    assert.equal(f.store.latestTask(f.session.id)?.status, 'failed', 'maintenance does not declare the coding task complete');
    assert.equal(f.store.get(f.session.id).summary, 'Concise complete checkpoint');
    assert.deepEqual(f.store.messages(f.session.id), original);
    assert.equal(f.store.requests(f.session.id, task.id).filter(r => r.purpose === 'compaction').length, 2);
  } finally { await f.cleanup(); }
});

test('Claude summary uses low effort with its independent output budget and records the actual effort', async () => {
  const f = await fixture();
  try {
    f.config.providers.test = { ...defaults.providers.argolink, auth: 'none', apiKeyEnv: '', stream: false };
    f.store.update(f.session.id, { model: 'claude-opus-5-5', effort: 'high' });
    for (let i = 0; i < 4; i++) { f.store.append(f.session.id, { role: 'user', content: [{ type: 'text', text: `task ${i}` }] }); f.store.append(f.session.id, text('done').message); }
    const provider = new HttpProvider({ ...f.config.providers.test, effort: 'high' }, 1000, async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      assert.equal(body.output_config.effort, 'low'); assert.equal(body.max_tokens, f.config.compactionMaxOutputTokens);
      return Response.json({ role: 'assistant', content: [{ type: 'text', text: 'Short checkpoint' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
    });
    await new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false }).compact(f.store.get(f.session.id), provider, true);
    assert.equal(f.store.requests(f.session.id)[0].requestedEffort, 'low');
    assert.equal(f.store.get(f.session.id).effort, 'high');
  } finally { await f.cleanup(); }
});

test('a terminal max_tokens SSE keeps partial JSON as evidence and returns no executable partial tool', async () => {
  const partialJson = '{"path":"never.txt","content":"unfinished';
  const events = [
    { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'partial', name: 'write_file', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } },
    { type: 'message_stop' },
  ];
  const provider = new HttpProvider({ ...defaults.providers.argolink, auth: 'none' }, 1000, async () => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
  const result = await provider.complete({ system: 's', messages: [], tools: [], maxTokens: 4096 });
  assert.equal(result.stopReason, 'max_tokens');
  assert.ok(result.message.content.every(b => b.type !== 'tool_use'));
  assert.deepEqual(result.incompleteToolCalls, [{ id: 'partial', name: 'write_file', partialJson }]);
});

test('goal review continues past an intermediate milestone and finishes only after remaining work is verified', async () => {
  const f = await fixture();
  try {
    f.config.goalCompletionCheck = true; f.config.maxPackCalls = 8;
    let actor = 0, reviews = 0;
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => fake(async req => {
      if (req.system.startsWith('You review whether')) {
        const input = JSON.parse((req.messages[0].content[0] as { text: string }).text);
        assert.equal(input.goal, 'Create proto.lua and transport.lua and verify both');
        reviews++;
        return text(JSON.stringify(reviews === 1 ? { decision: 'continue', reason: 'transport.lua is not created yet.', nextSteps: ['Create and verify transport.lua.'] } : { decision: 'complete', reason: 'Both requested files are created and verified.', nextSteps: [] }));
      }
      actor++;
      if (actor === 1) return reply([{ type: 'tool_use', id: 'proto', name: 'write_file', input: { path: 'proto.lua', content: '-- proto' } }], 'tool_use');
      if (actor === 2) return text('proto.lua is ready. The transport remains for later.');
      if (actor === 3) {
        assert.ok(req.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('Controller completion review'))));
        return reply([{ type: 'tool_use', id: 'transport', name: 'write_file', input: { path: 'transport.lua', content: '-- transport' } }], 'tool_use');
      }
      assert.equal(await readFile(join(f.workspace, 'proto.lua'), 'utf8'), '-- proto');
      assert.equal(await readFile(join(f.workspace, 'transport.lua'), 'utf8'), '-- transport');
      return text('Both files verified.');
    }) });
    assert.equal(await agent.run(f.session.id, 'Create proto.lua and transport.lua and verify both'), 'Both files verified.');
    assert.equal(actor, 4); assert.equal(reviews, 2);
    assert.equal(f.store.latestTask(f.session.id)?.status, 'completed');
    const requests = f.store.requests(f.session.id);
    assert.equal(requests.length, 6); assert.equal(new Set(requests.map(r => r.runId)).size, 1);
    assert.equal(requests.filter(r => r.purpose === 'completion-check').length, 2);
    assert.equal(agent.callsRemaining, 2);
  } finally { await f.cleanup(); }
});

test('a real external blocker pauses the same task rather than declaring the goal complete', async () => {
  const f = await fixture();
  try {
    f.config.goalCompletionCheck = true;
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => fake(async req => req.system.startsWith('You review whether') ? text(JSON.stringify({ decision: 'blocked', reason: 'User must supply a required server credential.', nextSteps: ['Ask the user for the missing configuration.'] })) : text('The server credential is missing.')) });
    const result = await agent.run(f.session.id, 'Connect the server');
    assert.match(result, /Blocked:/);
    assert.equal(f.store.latestTask(f.session.id)?.status, 'blocked');
    assert.equal(f.store.get(f.session.id).status, 'interrupted');
    assert.equal(f.store.requests(f.session.id).length, 2);
  } finally { await f.cleanup(); }
});

test('inconclusive goal reviews cannot mark completion or bypass the shared request cap', async () => {
  const f = await fixture();
  try {
    f.config.goalCompletionCheck = true;
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => fake(async () => text('not a structured review')) });
    await assert.rejects(agent.run(f.session.id, 'Finish and verify'), /budget exhausted/);
    assert.equal(f.store.requests(f.session.id).length, 5);
    assert.equal(f.store.latestTask(f.session.id)?.status, 'failed');
  } finally { await f.cleanup(); }
});

test('token-limit continuation can follow the task budget without the old two-response cutoff', async () => {
  const f = await fixture(); let calls = 0;
  try {
    f.config.maxResponseContinuations = -1;
    validateConfig(f.config);
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => fake(async () => ++calls <= 3 ? text('partial', 'max_tokens') : text('finished')) });
    assert.equal(await agent.run(f.session.id, 'Finish a long task'), 'finished');
    assert.equal(calls, 4); assert.equal(agent.callsRemaining, 1);
    assert.equal(new Set(f.store.requests(f.session.id).map(r => r.runId)).size, 1);
  } finally { await f.cleanup(); }
});

test('completion reviewers cannot execute tools even if a provider returns them', async () => {
  const f = await fixture();
  try {
    f.config.goalCompletionCheck = true;
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => fake(async req => {
      if (!req.system.startsWith('You review whether')) return text('Finished.');
      assert.equal(req.tools.length, 0);
      return reply([{ type: 'tool_use', id: 'forbidden', name: 'write_file', input: { path: 'must-not-exist.txt', content: 'unsafe' } }], 'tool_use');
    }) });
    await assert.rejects(agent.run(f.session.id, 'Verify the task'), /reviewer returned tools/);
    await assert.rejects(stat(join(f.workspace, 'must-not-exist.txt')), { code: 'ENOENT' });
    assert.equal(f.store.latestTask(f.session.id)?.status, 'failed');
  } finally { await f.cleanup(); }
});

test('helper completion review checks its assignment rather than the full parent goal', async () => {
  const f = await fixture();
  try {
    f.config.goalCompletionCheck = true;
    const child = f.store.create({ cwd: f.workspace, provider: 'test', model: 'test', permissionMode: 'read-only', parentId: f.session.id });
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => fake(async req => {
      if (!req.system.startsWith('You review whether')) return text('The assigned report is ready.');
      const input = JSON.parse((req.messages[0].content[0] as { text: string }).text);
      assert.equal(input.goal, 'Report the assigned result.');
      return text(JSON.stringify({ decision: 'complete', reason: 'The assigned report was produced.', nextSteps: [] }));
    }) });
    await agent.run(child.id, 'Reference context from parent: Build an entire application.\n\nYour assignment:\nReport the assigned result.');
    assert.equal(f.store.get(child.id).status, 'completed');
  } finally { await f.cleanup(); }
});

test('explicit continuation reopens a previously completed turn without resetting its task spending', async () => {
  const f = await fixture();
  try {
    const options = { config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => fake(async () => text('done')) };
    const first = new PuppyAgent(options); await first.run(f.session.id, 'Complete the goal');
    const second = new PuppyAgent(options); await second.run(f.session.id, 'Continue the same goal', true);
    assert.equal(second.runId, first.runId); assert.equal(second.callsRemaining, 3);
    assert.equal(f.store.requests(f.session.id).length, 2);
    assert.ok(Math.abs(second.creditsConsumed - 0.2) < 1e-9);
  } finally { await f.cleanup(); }
});

test('raising the shared request ceiling retains already consumed attempts on continuation', async () => {
  const f = await fixture();
  try {
    f.config.maxPackCalls = 1;
    const options = { config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => fake(async () => text('done')) };
    const first = new PuppyAgent(options); await first.run(f.session.id, 'Initial task');
    assert.equal(first.callsRemaining, 0);
    f.config.maxPackCalls = 3;
    const resumed = new PuppyAgent(options); await resumed.run(f.session.id, 'Continue', true);
    assert.equal(resumed.runId, first.runId);
    assert.equal(resumed.callsRemaining, 1, 'two requests remain counted against the increased total of three');
    assert.ok(Math.abs(resumed.creditsConsumed - 0.2) < 1e-9);
  } finally { await f.cleanup(); }
});
