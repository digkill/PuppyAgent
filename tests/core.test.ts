import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, stat, readdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cleanupRuntime } from '../src/temp.ts';
import { Store } from '../src/store.ts';
import { canonicalPath, Permissions } from '../src/permissions.ts';
import { defaults, prepareRuntime, validateConfig } from '../src/config.ts';
import { anthropicHistory, HttpProvider, openAIHistory } from '../src/provider.ts';
import { PuppyAgent } from '../src/agent.ts';
import { Tools, runCommand } from '../src/tools.ts';
import { activeHistory, compactionSplit } from '../src/context.ts';
import { systemPrompt } from '../src/instructions.ts';
import { helpText, language, t } from '../src/i18n.ts';
import { renderMascot } from '../src/mascot.ts';
import type { Block, Completion, Config, CompletionRequest, Provider, ProviderConfig } from '../src/types.ts';

const base = process.env.PUPPY_TEST_TMP;
if (!base) throw new Error('Set PUPPY_TEST_TMP to an explicit writable temporary directory.');

async function fixture() {
  await mkdir(base!, { recursive: true });
  const root = await mkdtemp(join(base!, 'test-'));
  const workspace = join(root, 'workspace'), tmpDir = join(root, 'tmp');
  await mkdir(workspace); await mkdir(tmpDir);
  const store = new Store(join(root, 'sessions.sqlite'));
  const config: Config = validateConfig({ ...defaults, tmpDir, dataDir: join(root, 'data'), providers: { test: { protocol: 'anthropic', auth: 'none', apiKeyEnv: '', baseUrl: 'http://localhost/v1', model: 'test' } }, provider: 'test' });
  const session = store.create({ cwd: workspace, provider: 'test', model: 'test', permissionMode: 'workspace-write' });
  return { root, workspace, tmpDir, store, config, session, async cleanup() { this.store.close(); await rm(root, { recursive: true, force: true }); } };
}
const response = (content: Block[], stopReason = 'end_turn'): Completion => ({ message: { role: 'assistant', content }, inputTokens: 10, outputTokens: 5, stopReason });
const text = (value: string): Completion => response([{ type: 'text', text: value }]);
const fake = (fn: (r: CompletionRequest) => Completion | Promise<Completion>): Provider => ({ complete: async r => fn(r), models: async () => ['test'] });
const providerCfg: ProviderConfig = { protocol: 'anthropic', baseUrl: 'https://example.com/v1', auth: 'none', apiKeyEnv: '', model: 'test' };
const call = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name, input });

test('config has English default, requires explicit temp, validates limits and provider URLs', () => {
  assert.throws(() => validateConfig({}), /tmpDir/);
  assert.equal(validateConfig({ tmpDir: base }).language, 'en');
  assert.equal(validateConfig({ tmpDir: base, language: 'ru' }).language, 'ru');
  assert.throws(() => validateConfig({ tmpDir: base, language: 'de' }), /language/);
  assert.throws(() => validateConfig({ tmpDir: base, maxSteps: -1 }), /maxSteps/);
  assert.throws(() => validateConfig({ tmpDir: base, permissionMode: 'magic' }), /permissionMode/);
  assert.throws(() => validateConfig({ tmpDir: base, provider: 'kie', providers: { kie: { ...providerCfg, baseUrl: 'http://remote.example/v1' } } }), /HTTPS/);
  assert.throws(() => validateConfig({ tmpDir: base, provider: 'kie', providers: { kie: { ...providerCfg, baseUrl: 'https://user:pass@example.com' } } }), /credentials/);
});

test('runtime uses configured temp variables and cleans its isolated folder', async () => {
  const f = await fixture();
  const saved = Object.fromEntries(['TMP', 'TMPDIR', 'TEMP'].map(k => [k, process.env[k]]));
  try {
    const path = await prepareRuntime(f.config);
    assert.ok(path.startsWith(f.tmpDir + '/run-'));
    for (const key of ['TMP', 'TMPDIR', 'TEMP']) assert.equal(process.env[key], path);
    await rm(path, { recursive: true });
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await f.cleanup();
  }
});

test('SQL persists full history, directory, language, permissions, memory and provider', async () => {
  const f = await fixture();
  try {
    f.store.append(f.session.id, { role: 'user', content: [{ type: 'text', text: 'hello' }] });
    f.store.update(f.session.id, { cwd: f.root, language: 'ru', permissionMode: 'full-access' });
    f.store.remember(`project:${f.workspace}`, 'stack', 'TypeScript');
    f.store.close();
    f.store = new Store(join(f.root, 'sessions.sqlite'));
    assert.equal(f.store.get(f.session.id).cwd, f.root);
    assert.equal(f.store.get(f.session.id).language, 'ru');
    assert.equal(f.store.get(f.session.id).permissionMode, 'full-access');
    assert.equal(f.store.get(f.session.id).provider, 'test');
    assert.equal(f.store.messages(f.session.id).length, 1);
    assert.equal(f.store.memory(`project:${f.workspace}`)[0].value, 'TypeScript');
    assert.equal(f.store.list(f.root)[0].id, f.session.id);
    assert.equal(f.store.list(f.workspace).length, 0);
    f.store.forget(`project:${f.workspace}`, 'stack');
    assert.equal(f.store.memory(`project:${f.workspace}`).length, 0);
  } finally { await f.cleanup(); }
});

test('session leases prevent two writers and allow stale-owner recovery', async () => {
  const f = await fixture();
  try {
    f.store.acquire(f.session.id, 'one');
    assert.throws(() => f.store.acquire(f.session.id, 'two'), /already running/);
    f.store.renew(f.session.id, 'one');
    f.store.release(f.session.id, 'wrong');
    assert.throws(() => f.store.acquire(f.session.id, 'two'), /already running/);
    f.store.db.prepare('UPDATE leases SET expires=0').run();
    f.store.acquire(f.session.id, 'two');
    assert.throws(() => f.store.renew(f.session.id, 'one'), /lease lost/);
  } finally { await f.cleanup(); }
});

test('permission matrix does not infer that a shell command is safe', async () => {
  const f = await fixture();
  try {
    const requests: unknown[] = [];
    const permissions = new Permissions('workspace-write', f.workspace, f.tmpDir, async r => { requests.push(r); return false; });
    await permissions.check({ action: 'read', target: join(f.workspace, 'new') });
    await permissions.check({ action: 'write', target: join(f.workspace, 'new') });
    await assert.rejects(permissions.check({ action: 'shell', target: f.workspace, detail: 'cat /etc/passwd' }), /denied/);
    await assert.rejects(permissions.check({ action: 'write', target: join(f.root, 'outside') }), /denied/);
    assert.equal(requests.length, 2);
    permissions.mode = 'read-only';
    await assert.rejects(permissions.check({ action: 'write', target: f.workspace }), /Read-only/);
    await assert.rejects(permissions.check({ action: 'read', target: f.root }), /outside/);
    permissions.mode = 'full-access';
    await permissions.check({ action: 'shell', target: '/' });
    assert.equal(requests.length, 2);
    permissions.mode = 'ask';
    await assert.rejects(permissions.check({ action: 'write', target: join(f.workspace, 'new') }), /denied/);
  } finally { await f.cleanup(); }
});

test('symlinks, dangling symlinks and sibling prefixes cannot escape the workspace silently', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'outside'));
    await symlink(join(f.root, 'outside'), join(f.workspace, 'link'));
    await symlink(join(f.root, 'missing'), join(f.workspace, 'dangling'));
    const p = new Permissions('workspace-write', f.workspace, f.tmpDir, async () => false);
    assert.equal(await canonicalPath(join(f.workspace, 'link', 'new.txt')), join(f.root, 'outside', 'new.txt'));
    await assert.rejects(p.check({ action: 'write', target: join(f.workspace, 'link', 'new.txt') }), /denied/);
    await assert.rejects(p.check({ action: 'write', target: f.workspace + '-other/file' }), /denied/);
    await assert.rejects(canonicalPath(join(f.workspace, 'dangling', 'file')), /Dangling symlink/);
  } finally { await f.cleanup(); }
});

test('file tools create, paginate, uniquely edit, refuse stale overwrite and load scoped instructions first', async () => {
  const f = await fixture();
  try {
    const permissions = new Permissions('workspace-write', f.workspace, f.tmpDir, async () => false);
    const tools = new Tools(f.config, f.store, f.session.id, permissions, f.tmpDir, { spawn: () => '', wait: async () => [], list: () => [] }, new AbortController().signal);
    await tools.seedInstructions();
    await tools.execute('write_file', { path: 'file.txt', content: 'one\ntwo\nthree' });
    assert.match(await tools.execute('read_file', { path: 'file.txt', startLine: 2, lineCount: 1 }), /2: two/);
    await assert.rejects(tools.execute('write_file', { path: 'file.txt', content: 'overwrite' }), /EEXIST/);
    await assert.rejects(tools.execute('write_file', { path: 'file.txt', content: 'overwrite', expectedContent: 'wrong' }), /does not match/);
    await tools.execute('edit_file', { path: 'file.txt', oldText: 'two', newText: 'second' });
    assert.equal(await readFile(join(f.workspace, 'file.txt'), 'utf8'), 'one\nsecond\nthree');
    await assert.rejects(tools.execute('edit_file', { path: 'file.txt', oldText: 'e', newText: 'E' }), /exactly once/);
    await mkdir(join(f.workspace, 'nested'));
    await writeFile(join(f.workspace, 'nested', 'AGENTS.md'), 'Use tabs here.');
    await assert.rejects(tools.execute('write_file', { path: 'nested/new.ts', content: 'hello' }), /Use tabs here/);
    await assert.rejects(stat(join(f.workspace, 'nested', 'new.ts')), /ENOENT/);
    await tools.execute('write_file', { path: 'nested/new.ts', content: 'hello' });
    assert.equal(await readFile(join(f.workspace, 'nested', 'new.ts'), 'utf8'), 'hello');
    assert.match(await systemPrompt(f.config, f.session, f.store, f.tmpDir, tools.seenInstructions), /Use tabs here/);
    assert.equal((await readdir(f.tmpDir)).length, 0);
  } finally { await f.cleanup(); }
});

test('shell receives the configured temp/cache paths without provider secrets', async () => {
  const f = await fixture();
  process.env.PUPPY_TEST_SECRET = 'should-not-leak';
  try {
    const result = await runCommand("node -e 'console.log(JSON.stringify({tmp:process.env.TMPDIR,cache:process.env.npm_config_cache,key:process.env.PUPPY_TEST_SECRET}))'", f.workspace, f.tmpDir, 3000, 2000, new AbortController().signal, ['PUPPY_TEST_SECRET']);
    assert.match(result, /exit=0/);
    assert.match(result, new RegExp(f.tmpDir));
    assert.doesNotMatch(result, /should-not-leak/);
  } finally { delete process.env.PUPPY_TEST_SECRET; await f.cleanup(); }
});

test('shell timeout kills the process group and bounds output', async () => {
  const f = await fixture();
  try {
    const result = await runCommand("node -e 'console.log(\"x\".repeat(10000)); setInterval(()=>{},1000)'", f.workspace, f.tmpDir, 1000, 100, new AbortController().signal);
    assert.match(result, /timeout=true/);
    assert.match(result, /Output truncated/);
    assert.ok(result.length < 250);
  } finally { await f.cleanup(); }
});

test('Anthropic adapter sends exact protocol, tools and authorization', async () => {
  process.env.PUPPY_PROVIDER_TEST_KEY = 'test-key';
  try {
    const provider = new HttpProvider({ ...providerCfg, auth: 'bearer', apiKeyEnv: 'PUPPY_PROVIDER_TEST_KEY' }, 1000, async (url, init) => {
      assert.equal(url, 'https://example.com/v1/messages');
      assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer test-key');
      assert.equal((init!.headers as Record<string, string>)['anthropic-version'], '2023-06-01');
      const body = JSON.parse(init!.body as string);
      assert.equal(body.messages[0].role, 'user');
      assert.equal(body.tools[0].name, 'read_file');
      return Response.json({ role: 'assistant', content: [call('a', 'read_file', { path: '.' })], usage: { input_tokens: 3, output_tokens: 2 }, stop_reason: 'tool_use' });
    });
    const res = await provider.complete({ system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [{ name: 'read_file', description: 'read', input_schema: {} }], maxTokens: 100 });
    assert.equal(res.inputTokens, 3);
    assert.equal(res.message.content[0].type, 'tool_use');
  } finally { delete process.env.PUPPY_PROVIDER_TEST_KEY; }
});

test('Anthropic gateway history merges adjacent turns and tool results without changing SQL content', () => {
  const history: CompletionRequest['messages'] = [
    { role: 'user', content: [{ type: 'text', text: 'First requirement.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Second requirement.' }] },
    { role: 'assistant', content: [call('a', 'read_file', { path: 'one' }), call('b', 'read_file', { path: 'two' })] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'one result' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'two result' }] },
    { role: 'user', content: [{ type: 'text', text: 'Continue carefully.' }] },
  ];
  const original = JSON.stringify(history);
  const wire = anthropicHistory(history);
  assert.deepEqual(wire.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(wire[0].content, 'First requirement.\n\nSecond requirement.');
  assert.ok(Array.isArray(wire[2].content));
  assert.deepEqual(wire[2].content.map(b => b.type), ['tool_result', 'tool_result', 'text']);
  assert.equal(JSON.stringify(history), original);
});

test('OpenAI adapter round-trips multiple tool calls and results', async () => {
  const provider = new HttpProvider({ ...providerCfg, protocol: 'openai-chat' }, 1000, async (url, init) => {
    assert.equal(url, 'https://example.com/v1/chat/completions');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.max_completion_tokens, 100);
    assert.equal(body.messages[1].tool_calls[0].function.arguments, '{"path":"."}');
    assert.equal(body.messages[2].role, 'tool');
    assert.equal(body.messages[3].role, 'tool');
    return Response.json({ choices: [{ message: { content: 'done', tool_calls: [{ id: 'c', function: { name: 'list_files', arguments: '{"path":"."}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  });
  const messages: CompletionRequest['messages'] = [
    { role: 'assistant', content: [call('a', 'read_file', { path: '.' }), call('b', 'read_file', { path: '..' })] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'one' }, { type: 'tool_result', tool_use_id: 'b', content: 'two' }] },
  ];
  assert.equal(openAIHistory(messages).length, 3);
  const res = await provider.complete({ system: 'sys', messages, tools: [], maxTokens: 100 });
  assert.equal(res.message.content.length, 2);
});

test('provider lists live models and fails without leaking HTTP response bodies', async () => {
  let calls = 0;
  const provider = new HttpProvider(providerCfg, 1000, async () => { calls++; return Response.json({ data: [{ id: 'real-model' }] }); });
  assert.deepEqual(await provider.models(), ['real-model']);
  assert.equal(calls, 1);
  const failing = new HttpProvider(providerCfg, 1000, async () => new Response('secret-provider-body', { status: 401 }));
  await assert.rejects(failing.models(), error => /HTTP 401/.test((error as Error).message) && !/secret-provider-body/.test((error as Error).message));
});

test('agent persists assistant tool calls before execution and restores cwd on the next API request', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.workspace, 'sub'));
    let step = 0;
    const provider = fake(req => {
      if (step++ === 0) return response([call('a', 'write_file', { path: 'hello.txt', content: 'hello' }), call('b', 'change_directory', { path: 'sub' })], 'tool_use');
      assert.match(req.system, new RegExp(join(f.workspace, 'sub')));
      assert.equal(f.store.messages(f.session.id).filter(m => m.content.some(b => b.type === 'tool_result')).length, 2);
      return text('done');
    });
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => provider, emit: e => {
      if (e.type === 'tool_start') assert.ok(f.store.messages(f.session.id).some(m => m.content.some(b => b.type === 'tool_use')));
    } });
    assert.equal(await agent.run(f.session.id, 'create a greeting'), 'done');
    assert.equal(await readFile(join(f.workspace, 'hello.txt'), 'utf8'), 'hello');
    assert.equal(f.store.get(f.session.id).cwd, join(f.workspace, 'sub'));
    assert.equal(f.store.get(f.session.id).inputTokens, 20);
  } finally { await f.cleanup(); }
});

test('interrupted tools are never automatically replayed and history is protocol-valid on resume', async () => {
  const f = await fixture();
  try {
    f.store.append(f.session.id, { role: 'user', content: [{ type: 'text', text: 'write a file' }] });
    f.store.append(f.session.id, { role: 'assistant', content: [call('unresolved', 'write_file', { path: 'danger.txt', content: 'do not repeat' })] });
    let recovered = false;
    const provider = fake(req => {
      const result = req.messages.flatMap(m => m.content).find(b => b.type === 'tool_result');
      assert.ok(result && result.type === 'tool_result');
      assert.equal(result.tool_use_id, 'unresolved');
      assert.match(result.content, /NOT automatically replayed/);
      recovered = true;
      return text('I will inspect first.');
    });
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false, providerFactory: () => provider });
    await agent.run(f.session.id, 'continue');
    assert.ok(recovered);
    await assert.rejects(stat(join(f.workspace, 'danger.txt')), /ENOENT/);
  } finally { await f.cleanup(); }
});

test('model cannot bypass read-only permissions through tools', async () => {
  const f = await fixture();
  try {
    f.store.update(f.session.id, { permissionMode: 'read-only' });
    let step = 0;
    const provider = fake(req => {
      if (step++ === 0) return response([call('a', 'write_file', { path: 'no.txt', content: 'bad' }), call('b', 'run_command', { command: 'touch no-shell.txt' })], 'tool_use');
      const results = req.messages.flatMap(m => m.content).filter(b => b.type === 'tool_result');
      assert.equal(results.length, 2);
      assert.ok(results.every(b => b.is_error));
      return text('Permission checks respected.');
    });
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => { throw new Error('read-only should never ask'); }, providerFactory: () => provider });
    await agent.run(f.session.id, 'write despite read-only');
    assert.deepEqual(await readdir(f.workspace), []);
  } finally { await f.cleanup(); }
});

test('helper puppies run with inherited permissions, Russian language and shared request budget', async () => {
  const f = await fixture();
  try {
    f.store.update(f.session.id, { permissionMode: 'read-only', language: 'ru' });
    const steps = new Map<string, number>();
    let agent: PuppyAgent;
    agent = new PuppyAgent({ config: { ...f.config, maxPackCalls: 5 }, store: f.store, tmpDir: f.tmpDir, approve: async () => false,
      providerFactory: s => fake(async req => {
        const step = steps.get(s.id) || 0; steps.set(s.id, step + 1);
        if (s.parentId) {
          assert.equal(s.permissionMode, 'read-only'); assert.equal(s.language, 'ru');
          assert.equal(s.workspace, f.workspace); assert.match(req.system, /Russian/);
          await new Promise(r => setTimeout(r, 25));
          return text('Helper result');
        }
        if (step === 0) return response([call('a', 'spawn_puppy', { task: 'inspect A', name: 'A' }), call('b', 'spawn_puppy', { task: 'inspect B', name: 'B' })], 'tool_use');
        if (step === 1) return response([call('c', 'wait_puppies', { ids: [...agent.jobs.keys()] })], 'tool_use');
        return text('Verified both reports.');
      }),
    });
    assert.equal(await agent.run(f.session.id, 'inspect independently'), 'Verified both reports.');
    assert.equal(agent.jobs.size, 2);
    assert.ok([...agent.jobs.values()].every(j => j.status === 'completed'));
    assert.equal(agent.callsRemaining, 0);
  } finally { await f.cleanup(); }
});

test('shared budget stops execution instead of spawning unbounded work', async () => {
  const f = await fixture();
  try {
    const agent = new PuppyAgent({ config: { ...f.config, maxPackCalls: 1 }, store: f.store, tmpDir: f.tmpDir, approve: async () => false,
      providerFactory: () => fake(() => response([call('a', 'list_files', { path: '.' })], 'tool_use')) });
    await assert.rejects(agent.run(f.session.id, 'keep going'), /budget exhausted/);
    assert.equal(f.store.get(f.session.id).status, 'failed');
  } finally { await f.cleanup(); }
});

test('restored parents can inspect old helper results without replaying helper work', async () => {
  const f = await fixture();
  try {
    const child = f.store.create({ cwd: f.workspace, provider: 'test', model: 'test', permissionMode: 'read-only', parentId: f.session.id, title: 'Earlier scout' });
    f.store.append(child.id, { role: 'assistant', content: [{ type: 'text', text: 'Saved helper report' }] });
    f.store.update(child.id, { status: 'completed' });
    const orphan = f.store.create({ cwd: f.workspace, provider: 'test', model: 'test', permissionMode: 'read-only', parentId: f.session.id });
    f.store.update(orphan.id, { status: 'running' });
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false });
    agent.recover(f.session.id);
    assert.equal(f.store.get(orphan.id).status, 'interrupted');
    assert.match(JSON.stringify(agent.listJobs(f.session.id)), /Saved helper report/);
    assert.match(JSON.stringify(await agent.waitJobs(f.session.id, [child.id])), /Saved helper report/);
    await assert.rejects(agent.waitJobs(f.session.id, [f.session.id]), /Not a direct helper/);
    assert.equal(agent.jobs.size, 0);
  } finally { await f.cleanup(); }
});

test('parent receives a completed helper report even if it forgot to wait', async () => {
  const f = await fixture();
  try {
    let rootStep = 0;
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false,
      providerFactory: s => fake(async req => {
        if (s.parentId) return text('Important helper finding.');
        rootStep++;
        if (rootStep === 1) return response([call('a', 'spawn_puppy', { task: 'investigate', name: 'Scout' })], 'tool_use');
        if (rootStep === 2) { await new Promise(r => setTimeout(r, 30)); return text('Premature final answer.'); }
        assert.ok(req.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('Important helper finding.'))));
        return text('Final answer includes helper evidence.');
      }),
    });
    assert.equal(await agent.run(f.session.id, 'delegate and review'), 'Final answer includes helper evidence.');
    assert.equal(rootStep, 3);
  } finally { await f.cleanup(); }
});

test('pack depth, total helpers and parallel helper limits are enforced', async () => {
  const f = await fixture();
  try {
    const agent = new PuppyAgent({ config: { ...f.config, maxChildren: 1, maxParallelChildren: 1 }, store: f.store, tmpDir: f.tmpDir, approve: async () => false,
      providerFactory: () => fake(() => text('done')) });
    assert.throws(() => agent.spawn(f.session.id, 'task', 'nested', f.config.maxDepth), /nesting depth/);
    agent.spawn(f.session.id, 'task', 'one', 0);
    assert.throws(() => agent.spawn(f.session.id, 'task', 'two', 0), /helper limit/);
    await agent.drain();
    const parallel = new PuppyAgent({ config: { ...f.config, maxParallelChildren: 1 }, store: f.store, tmpDir: f.tmpDir, approve: async () => false,
      providerFactory: () => fake(() => text('done')) });
    parallel.spawn(f.session.id, 'task', 'one', 0);
    assert.throws(() => parallel.spawn(f.session.id, 'task', 'two', 0), /Parallel helper limit/);
    await parallel.drain();
  } finally { await f.cleanup(); }
});

test('cancellation during API execution marks the session interrupted without executing returned tools', async () => {
  const f = await fixture();
  try {
    let agent: PuppyAgent;
    agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false,
      providerFactory: () => fake(() => { agent.cancel(); return response([call('a', 'write_file', { path: 'cancelled.txt', content: 'bad' })], 'tool_use'); }) });
    await assert.rejects(agent.run(f.session.id, 'test cancellation'), /Cancelled/);
    assert.equal(f.store.get(f.session.id).status, 'interrupted');
    assert.deepEqual(await readdir(f.workspace), []);
    f.store.acquire(f.session.id, 'new-owner'); // Lease was released.
  } finally { await f.cleanup(); }
});

test('an instruction-file symlink cannot silently include data outside the workspace', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'private.txt'), 'secret outside workspace');
    await symlink(join(f.root, 'private.txt'), join(f.workspace, 'AGENTS.md'));
    await assert.rejects(systemPrompt(f.config, f.session, f.store, f.tmpDir), /symlink escapes/);
  } finally { await f.cleanup(); }
});

test('compaction accepts signed thinking while keeping original transcript and complete tool pairs', async () => {
  const f = await fixture();
  try {
    for (let turn = 0; turn < 4; turn++) {
      f.store.append(f.session.id, { role: 'user', content: [{ type: 'text', text: `task ${turn}` }] });
      f.store.append(f.session.id, { role: 'assistant', content: [call(`c${turn}`, 'list_files', { path: '.' })] });
      f.store.append(f.session.id, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${turn}`, content: 'result' }] });
      f.store.append(f.session.id, { role: 'assistant', content: [{ type: 'text', text: 'done' }] });
    }
    const before = f.store.messages(f.session.id);
    const split = compactionSplit(before)!;
    assert.equal(split.recent[0].content[0].type, 'text');
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false });
    await agent.compact(f.store.get(f.session.id), fake(() => response([{ type: 'thinking', thinking: 'Summarizing the earlier turns.', signature: 'signed-summary-reasoning' }, { type: 'text', text: 'Summary of earlier tasks.' }])), true);
    assert.equal(f.store.messages(f.session.id).length, before.length);
    assert.equal(f.store.get(f.session.id).summary, 'Summary of earlier tasks.');
    assert.equal(f.store.messages(f.session.id, f.store.get(f.session.id).summaryThrough).length, 8);
    assert.equal(f.store.requests(f.session.id)[0].purpose, 'compaction');
  } finally { await f.cleanup(); }
});

test('oversized single task fails without silent message loss or API request', async () => {
  const f = await fixture();
  try {
    let called = false;
    const agent = new PuppyAgent({ config: { ...f.config, contextBudgetTokens: 1000, maxOutputTokens: 100 }, store: f.store, tmpDir: f.tmpDir, approve: async () => false,
      providerFactory: () => fake(() => { called = true; return text('should not run'); }) });
    await assert.rejects(agent.run(f.session.id, 'x'.repeat(10000)), /No history was discarded/);
    assert.equal(called, false);
    assert.equal(f.store.messages(f.session.id)[0].content[0].type, 'text');
    assert.equal(f.store.get(f.session.id).summaryThrough, 0);
  } finally { await f.cleanup(); }
});

test('a long single task can compact complete tool rounds while retaining its exact original request', async () => {
  const f = await fixture();
  try {
    const task = f.store.append(f.session.id, { role: 'user', content: [{ type: 'text', text: 'Keep this exact user requirement.' }] });
    for (let round = 0; round < 6; round++) {
      f.store.append(f.session.id, { role: 'assistant', content: [call(`c${round}`, 'list_files', { path: '.' })] });
      f.store.append(f.session.id, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${round}`, content: 'some tool evidence' }] });
    }
    const agent = new PuppyAgent({ config: f.config, store: f.store, tmpDir: f.tmpDir, approve: async () => false });
    await agent.compact(f.store.get(f.session.id), fake(() => text('Earlier tool rounds summarized.')), true);
    const saved = f.store.get(f.session.id);
    const active = activeHistory(f.store.messages(saved.id), saved.summaryThrough);
    assert.equal(active[0].id, task.id);
    assert.equal(active.length, 5);
    assert.equal(f.store.messages(saved.id).length, 13);
    const toolIds = new Set(active.flatMap(m => m.content).filter(b => b.type === 'tool_use').map(b => b.id));
    for (const b of active.flatMap(m => m.content)) if (b.type === 'tool_result') assert.ok(toolIds.has(b.tool_use_id));
  } finally { await f.cleanup(); }
});

test('instructions, memory, language and workspace are included in context', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, 'AGENTS.md'), 'Use the existing design.');
    f.store.remember(`project:${f.workspace}`, 'framework', 'Node.js');
    f.store.update(f.session.id, { language: 'ru' });
    const prompt = await systemPrompt(f.config, f.store.get(f.session.id), f.store, f.tmpDir);
    assert.match(prompt, /Russian/); assert.match(prompt, /existing design/); assert.match(prompt, /Node.js/);
    assert.ok(prompt.includes(f.tmpDir));
  } finally { await f.cleanup(); }
});

test('mascot has TrueColor, compact and Russian variants without a Python dependency', () => {
  const color = renderMascot({ language: 'en', columns: 80, color: true });
  assert.equal(color.trimEnd().split('\n').length, 29);
  assert.match(color, /Created by MediaRise · \x1b\[38;2;239;68;68mMediaRise\.org\x1b\[0m/);
  assert.match(color, /\x1b\[38;2;/);
  assert.match(color, /your loyal AI coding companion/);
  assert.match(renderMascot({ language: 'ru', color: true }), /готов к работе/);
  const plain = renderMascot({ language: 'en', color: false });
  assert.doesNotMatch(plain, /\x1b/);
  assert.match(renderMascot({ language: 'ru', columns: 40 }), /твой верный/);
  assert.equal(language('ru'), 'ru');
  assert.throws(() => language('de'));
  assert.match(helpText('ru'), /Режимы/);
  assert.equal(t('en', 'you'), 'you'); assert.equal(t('ru', 'you'), 'ты');
});

async function cli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', resolve('src/cli.ts'), ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    child.on('error', reject); child.on('close', code => resolveResult({ code, output }));
  });
}

test('CLI runs with a mocked API transport, persists sessions and removes runtime temp', async () => {
  const f = await fixture();
  try {
    // Inject at the standard fetch boundary. No port binding, network, credentials or model billing.
    const transport = join(f.root, 'transport.mjs');
    await writeFile(transport, `
      let requests = 0;
      globalThis.fetch = async (url, init) => {
        if (url !== 'https://example.com/v1/messages') throw new Error('Unexpected URL');
        const body = JSON.parse(init.body);
        if (!body.system.includes('Russian')) throw new Error('Language missing');
        requests++;
        const reply = { role: 'assistant', content: requests === 1
          ? [{ type: 'tool_use', id: 'write', name: 'write_file', input: { path: 'cli.txt', content: 'hello from CLI' } }]
          : [{ type: 'text', text: 'Готово' }], stop_reason: requests === 1 ? 'tool_use' : 'end_turn', credits_consumed: 0.2,
          usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 1 } };
        if (!body.stream) return Response.json(reply);
        const events = [{ type: 'message_start', message: { role: 'assistant', content: [], usage: { ...reply.usage, output_tokens: 0 } } }];
        reply.content.forEach((block, index) => {
          events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
          events.push({ type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
          events.push({ type: 'content_block_stop', index });
        });
        events.push({ type: 'message_delta', delta: { stop_reason: reply.stop_reason }, usage: { output_tokens: 1 }, credits_consumed: 0.2 }, { type: 'message_stop' });
        return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\\n\\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
      };
    `);
    const path = join(f.root, 'config.json');
    await writeFile(path, JSON.stringify({ ...f.config, language: 'ru', permissionMode: 'workspace-write', providers: { test: { ...providerCfg, stream: true, maxTaskCredits: 10 } } }));
    const env = { PUPPY_ENV_FILE: join(f.root, 'no-provider.env'), PUPPY_PROVIDER: 'test', PUPPY_CONFIG: path, PUPPY_TMP_DIR: f.tmpDir, TMPDIR: f.tmpDir, TMP: f.tmpDir, TEMP: f.tmpDir, NODE_OPTIONS: `--import=${pathToFileURL(transport).href}` };
    const result = await cli(['run', 'write a greeting'], env, f.workspace);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Готово/);
    assert.equal(result.output.match(/Готово/g)?.length, 1, 'Streamed text should not be printed twice.');
    assert.equal(await readFile(join(f.workspace, 'cli.txt'), 'utf8'), 'hello from CLI');
    const sessions = await cli(['sessions', '--here'], env, f.workspace);
    assert.equal(sessions.code, 0, sessions.output);
    assert.ok(sessions.output.includes(f.workspace));
    const usage = await cli(['usage', '--json'], env, f.workspace);
    assert.equal(usage.code, 0, usage.output);
    const report = JSON.parse(usage.output.split('\n').filter(line => !line.startsWith('(node:') && !line.startsWith('(Use ')).join('\n'));
    assert.equal(report.summary.requests, 2);
    assert.equal(report.summary.credits.requestsUnknown, 0);
    assert.equal(report.summary.credits.reported, 0.4);
    assert.ok(report.requests.every((r: { metrics: { streamed: boolean } }) => r.metrics.streamed));
    assert.deepEqual(await readdir(f.tmpDir), []);
    const persistent = new Store(join(f.config.dataDir, 'sessions.sqlite'));
    try {
      assert.equal(persistent.list()[0].language, 'ru');
      assert.equal(persistent.messages(persistent.list()[0].id).length, 4);
    } finally { persistent.close(); }
  } finally {
    await f.cleanup();
  }
});

test('runtime cleanup removes read-only module caches without following directory symlinks', async () => {
  const f = await fixture();
  const runtime = join(f.tmpDir, 'run-readonly');
  const cache = join(runtime, 'modules', 'dependency');
  const outside = join(f.workspace, 'outside-cache');
  try {
    await mkdir(cache, { recursive: true }); await mkdir(outside, { mode: 0o750 });
    await writeFile(join(cache, 'source.go'), 'package dependency', { mode: 0o444 });
    await writeFile(join(outside, 'preserve.txt'), 'preserve');
    await symlink(outside, join(runtime, 'external-link'));
    const outsideMode = (await stat(outside)).mode;
    await chmod(cache, 0o555);
    await cleanupRuntime(runtime);
    await assert.rejects(stat(runtime), { code: 'ENOENT' });
    assert.equal(await readFile(join(outside, 'preserve.txt'), 'utf8'), 'preserve');
    assert.equal((await stat(outside)).mode, outsideMode);
  } finally { await cleanupRuntime(runtime); await f.cleanup(); }
});


test('CLI restore applies explicit permission environment, honors the flag and otherwise keeps saved permissions', async () => {
  const f = await fixture();
  try {
    const config = join(f.root, 'permissions-config.json');
    await writeFile(config, JSON.stringify({ ...f.config, dataDir: f.root, permissionMode: 'workspace-write' }));
    const env = { PUPPY_ENV_FILE: join(f.root, 'absent.env'), PUPPY_CONFIG: config, PUPPY_TMP_DIR: f.tmpDir, TMPDIR: f.tmpDir, TMP: f.tmpDir, TEMP: f.tmpDir, PUPPY_PERMISSION_MODE: 'full-access' };
    const explicit = await cli(['resume', f.session.id, '--no-banner'], env, f.workspace);
    assert.match(explicit.output, /full-access/);
    assert.equal(f.store.get(f.session.id).permissionMode, 'full-access');
    const flag = await cli(['resume', f.session.id, '--permission', 'read-only', '--no-banner'], env, f.workspace);
    assert.match(flag.output, /read-only/);
    assert.equal(f.store.get(f.session.id).permissionMode, 'read-only');
    f.store.update(f.session.id, { permissionMode: 'ask' });
    await cli(['resume', f.session.id, '--no-banner'], { ...env, PUPPY_PERMISSION_MODE: undefined }, f.workspace);
    assert.equal(f.store.get(f.session.id).permissionMode, 'ask');
  } finally { await f.cleanup(); }
});
