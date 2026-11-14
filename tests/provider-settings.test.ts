import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaults, environmentDefaults, validateConfig } from '../src/config.ts';
import { routeProvider } from '../src/provider-routing.ts';
import { HttpProvider, ProviderFailure } from '../src/provider.ts';
import { PuppyAgent } from '../src/agent.ts';
import { Store } from '../src/store.ts';
import type { Completion, ProviderConfig } from '../src/types.ts';

const base = process.env.PUPPY_TEST_TMP;
if (!base) throw new Error('Set PUPPY_TEST_TMP explicitly.');
async function fixture() {
  await mkdir(base!, { recursive: true });
  const root = await mkdtemp(join(base!, 'provider-settings-'));
  const config = validateConfig({ ...defaults, tmpDir: root, dataDir: root, provider: 'test', providers: { test: { protocol: 'anthropic', baseUrl: 'https://example.com/v1', auth: 'none', apiKeyEnv: '', model: 'test' } } });
  const store = new Store(join(root, 'sessions.sqlite'));
  const session = store.create({ cwd: root, provider: 'test', model: 'test', permissionMode: 'read-only' });
  return { root, config, store, session, async cleanup() { store.close(); await rm(root, { recursive: true, force: true }); } };
}
function answer(value = 'done'): Completion { return { message: { role: 'assistant', content: [{ type: 'text', text: value }] }, inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' }; }
function stream(events: unknown[], done = true): Response {
  return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } });
}

test('env controls provider, local endpoint, memory, function calling, output and streaming independently', () => {
  const values = { PUPPY_PROVIDER: 'ollama', PUPPY_MODEL: 'qwen2.5-coder:7b', PUPPY_EFFORT: 'auto', PUPPY_FALLBACK_MODEL: 'llama3.1:8b', PUPPY_BASE_URL: 'http://127.0.0.1:8081/v1', PUPPY_MEMORY: 'false', PUPPY_FUNCTION_CALLING: 'false', PUPPY_MAX_TOKENS: '2048', PUPPY_STREAM: 'true' };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, values);
    const cfg = environmentDefaults(validateConfig({ ...defaults, tmpDir: base }));
    assert.equal(cfg.provider, 'ollama'); assert.equal(cfg.providers.ollama.model, 'qwen2.5-coder:7b');
    assert.equal(cfg.providers.ollama.baseUrl, values.PUPPY_BASE_URL);
    assert.equal(cfg.providers.ollama.fallbackModel, 'llama3.1:8b');
    assert.equal(cfg.providers.ollama.auth, 'none'); assert.equal(cfg.providers.ollama.maxTaskCredits, undefined);
    assert.equal(cfg.conversationMemory, false); assert.equal(cfg.functionCalling, false); assert.equal(cfg.maxOutputTokens, 2048);
    process.env.PUPPY_STREAM = 'sometimes';
    assert.throws(() => environmentDefaults(cfg), /PUPPY_STREAM/);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('Kie routes Claude and Gemini separately and reports Gemini chat-only capability', () => {
  assert.equal(defaults.providers.kie.model, 'claude-opus-5-5');
  for (const model of ['claude-opus-5-5', 'claude-fable-5', 'claude-sonnet-5-5']) {
    const claude = routeProvider(defaults.providers.kie, model);
    assert.equal(claude.model, model);
    assert.equal(claude.protocol, 'anthropic'); assert.equal(claude.supportsTools, true);
    assert.equal(claude.baseUrl, 'https://api.kie.ai/claude/v1');
  }
  const gemini = routeProvider(defaults.providers.kie, 'gemini-4-carbon-openai', 'medium');
  assert.equal(gemini.protocol, 'openai-chat');
  assert.equal(gemini.baseUrl, 'https://api.kie.ai/gemini-4-carbon-openai/v1');
  assert.equal(gemini.supportsTools, false); assert.equal(gemini.maxTokensParameter, 'max_tokens');
  assert.throws(() => routeProvider(defaults.providers.kie, 'unrecognized-model'), /No verified Kie route/);
});

test('OpenAI-compatible local streaming assembles tool arguments and final usage without an API key', async () => {
  const config: ProviderConfig = { ...defaults.providers.ollama, model: 'qwen2.5-coder:7b' };
  const provider = new HttpProvider(config, 1000, async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal((init!.headers as Record<string, string>).authorization, undefined);
    const body = JSON.parse(init!.body as string);
    assert.equal(body.max_tokens, 200); assert.equal(body.reasoning_effort, undefined);
    return stream([
      { id: 'local', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'list_', arguments: '{"pa' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'files', arguments: 'th":"."}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 123, completion_tokens: 20 } },
    ]);
  });
  const result = await provider.complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'list files' }] }], tools: [{ name: 'list_files', description: 'list', input_schema: { type: 'object' } }], maxTokens: 200 });
  assert.deepEqual(result.message.content[0], { type: 'tool_use', id: 'call-1', name: 'list_files', input: { path: '.' } });
  assert.equal(result.metrics?.usage.inputTokens, 123); assert.equal(result.metrics?.creditsConsumed, null);
});

test('Gemini uses its own route, max_tokens, reasoning_effort and final request credits', async () => {
  const provider = new HttpProvider({ ...defaults.providers.kie, model: 'gemini-4-carbon-openai', effort: 'low' }, 1000, async (url, init) => {
    assert.equal(url, 'https://api.kie.ai/gemini-4-carbon-openai/v1/chat/completions');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.max_tokens, 32); assert.equal(body.reasoning_effort, 'low'); assert.equal(body.tools, undefined);
    assert.equal(body.stream_options, undefined);
    return stream([{ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 }, credits_consumed: 0.01 }]);
  });
  const oldKey = process.env.KIE_API_KEY; process.env.KIE_API_KEY = 'fixture-not-real';
  try {
    const r = await provider.complete({ system: 's', messages: [], tools: [], maxTokens: 32 });
    assert.equal(r.metrics?.creditsConsumed, 0.01); assert.equal(r.metrics?.streamed, true);
  } finally { if (oldKey === undefined) delete process.env.KIE_API_KEY; else process.env.KIE_API_KEY = oldKey; }
});

test('truncated OpenAI streams reject partial tools; HTTP-200 API errors remain visible without echoing bodies', async () => {
  const config: ProviderConfig = { ...defaults.providers.ollama, model: 'test' };
  const incomplete = new HttpProvider(config, 1000, async () => stream([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'run_command', arguments: '{"command":' } }] } }] }], false));
  await assert.rejects(incomplete.complete({ system: 's', messages: [], tools: [], maxTokens: 10 }), /Incomplete OpenAI stream/);
  const error = new HttpProvider(config, 1000, async () => Response.json({ code: 422, msg: 'sensitive provider body', credits_consumed: 0 }));
  await assert.rejects(error.complete({ system: 's', messages: [], tools: [], maxTokens: 10 }), e => e instanceof ProviderFailure && /API code 422/.test(e.message) && !e.message.includes('sensitive provider body'));
});

test('Kie Gemini chat streams may end with usage and DONE but no finish_reason; tools still require one', async () => {
  const oldKey = process.env.KIE_API_KEY; process.env.KIE_API_KEY = 'fixture-not-real';
  try {
    const provider = new HttpProvider({ ...defaults.providers.kie, model: 'gemini-4-carbon-openai', effort: 'auto' }, 1000, async () => stream([
      { choices: [{ delta: { role: 'assistant', content: 'OK' } }] },
      { choices: [], usage: { prompt_tokens: 42, completion_tokens: 5 }, credits_consumed: 0.01 },
    ]));
    const result = await provider.complete({ system: 's', messages: [], tools: [], maxTokens: 32 });
    assert.equal(result.stopReason, 'gateway_done'); assert.equal(result.metrics?.creditsConsumed, 0.01);
  } finally { if (oldKey === undefined) delete process.env.KIE_API_KEY; else process.env.KIE_API_KEY = oldKey; }
});

test('memory=false keeps current task/tool rounds on continue and preserves the original SQL history', async () => {
  const f = await fixture();
  try {
    f.config.conversationMemory = false; f.config.maxSteps = 1;
    f.store.append(f.session.id, { role: 'user', content: [{ type: 'text', text: 'OLD FINISHED TASK' }] });
    f.store.append(f.session.id, { role: 'assistant', content: [{ type: 'text', text: 'OLD RESULT' }] });
    f.store.update(f.session.id, { summary: 'OLD SUMMARY' });
    const first = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.root, approve: async () => false, providerFactory: () => ({ models: async () => [], complete: async req => {
      assert.ok(!JSON.stringify(req.messages).includes('OLD'));
      assert.ok(!req.system.includes('OLD SUMMARY'));
      return { ...answer(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'list', name: 'list_files', input: { path: '.' } }] }, stopReason: 'tool_use' };
    } }) });
    await assert.rejects(first.run(f.session.id, 'CURRENT TASK'), /step limit/);
    const second = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.root, approve: async () => false, providerFactory: () => ({ models: async () => [], complete: async req => {
      const history = JSON.stringify(req.messages);
      assert.ok(history.includes('CURRENT TASK')); assert.ok(history.includes('tool_result')); assert.ok(!history.includes('OLD FINISHED TASK'));
      return answer();
    } }) });
    await second.run(f.session.id, 'continue', true);
    assert.ok(JSON.stringify(f.store.messages(f.session.id)).includes('OLD FINISHED TASK'));
  } finally { await f.cleanup(); }
});

test('function calling=false refuses unexpected tool actions and sends reference-only tool history', async () => {
  const f = await fixture();
  try {
    f.config.functionCalling = false;
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.root, approve: async () => false, providerFactory: () => ({ models: async () => [], complete: async req => {
      assert.equal(req.tools.length, 0); assert.ok(req.system.includes('CHAT-ONLY MODE'));
      return { ...answer(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'write', name: 'write_file', input: { path: 'must-not-write', content: 'no' } }] }, stopReason: 'tool_use' };
    } }) });
    await assert.rejects(agent.run(f.session.id, 'work'), /function calling is disabled/);
    assert.ok(JSON.stringify(f.store.messages(f.session.id)).includes('Not executed'));
    await assert.rejects(stat(join(f.root, 'must-not-write')), /ENOENT/);
  } finally { await f.cleanup(); }
});

test('memory-disabled compaction keeps a separate task checkpoint and retains full-conversation summaries', async () => {
  const f = await fixture();
  try {
    f.config.conversationMemory = false;
    f.store.append(f.session.id, { role: 'user', content: [{ type: 'text', text: 'Old task' }] });
    const oldEnd = f.store.append(f.session.id, { role: 'assistant', content: [{ type: 'text', text: 'Old answer' }] });
    f.store.update(f.session.id, { summary: 'Full conversation checkpoint', summaryThrough: oldEnd.id });
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.root, approve: async () => false });
    agent.beginTask(f.session.id, false);
    f.store.append(f.session.id, { role: 'user', content: [{ type: 'text', text: 'Current task' }] });
    for (let i = 0; i < 6; i++) {
      f.store.append(f.session.id, { role: 'assistant', content: [{ type: 'tool_use', id: String(i), name: 'list_files', input: { path: '.' } }] });
      f.store.append(f.session.id, { role: 'user', content: [{ type: 'tool_result', tool_use_id: String(i), content: 'files' }] });
    }
    await agent.compact(f.store.get(f.session.id), { models: async () => [], complete: async () => answer('Current task checkpoint') }, true);
    assert.equal(f.store.get(f.session.id).summary, 'Full conversation checkpoint');
    assert.equal(f.store.taskContext(agent.runId, f.session.id)?.summary, 'Current task checkpoint');
    assert.equal(agent.contextSession(f.store.get(f.session.id)).summary, 'Current task checkpoint');
    assert.equal(f.store.messages(f.session.id).length, 15);
  } finally { await f.cleanup(); }
});
