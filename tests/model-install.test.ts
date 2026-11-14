import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { buildPackage, newerVersion } from '../src/install.ts';
import { defaults, environmentDefaults, validateConfig } from '../src/config.ts';
import { EFFORTS, parseEffort } from '../src/model-settings.ts';
import { HttpProvider } from '../src/provider.ts';
import { Store } from '../src/store.ts';
import { PuppyAgent } from '../src/agent.ts';
import type { Completion, ProviderConfig } from '../src/types.ts';

const base = process.env.PUPPY_TEST_TMP;
if (!base) throw new Error('Set PUPPY_TEST_TMP explicitly.');
const currentVersion: string = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
async function temporary(): Promise<string> { await mkdir(base!, { recursive: true }); return mkdtemp(join(base!, 'model-install-')); }
function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    child.on('error', reject); child.on('close', code => resolveResult({ code, output }));
  });
}

test('model and effort environment defaults are validated without mutating provider settings', () => {
  const saved = { model: process.env.PUPPY_MODEL, effort: process.env.PUPPY_EFFORT };
  try {
    process.env.PUPPY_MODEL = 'claude-opus-5-5'; process.env.PUPPY_EFFORT = 'high';
    const original = validateConfig({ ...defaults, tmpDir: base });
    const selected = environmentDefaults(original);
    assert.equal(selected.providers.kie.effort, 'high');
    assert.equal(original.providers.kie.effort, undefined);
    for (const effort of EFFORTS) assert.equal(parseEffort(effort), effort);
    assert.throws(() => parseEffort('ultra'));
    process.env.PUPPY_EFFORT = 'invalid';
    assert.throws(() => environmentDefaults(original), /Effort/);
  } finally {
    if (saved.model === undefined) delete process.env.PUPPY_MODEL; else process.env.PUPPY_MODEL = saved.model;
    if (saved.effort === undefined) delete process.env.PUPPY_EFFORT; else process.env.PUPPY_EFFORT = saved.effort;
  }
});

test('effort is transmitted with the native protocol and auto omits the parameter', async () => {
  for (const protocol of ['anthropic', 'openai-chat'] as const) {
    for (const effort of ['high', 'auto'] as const) {
      const config: ProviderConfig = { protocol, auth: 'none', apiKeyEnv: '', baseUrl: 'https://example.com/v1', model: 'test', effort };
      const provider = new HttpProvider(config, 1000, async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        assert.equal(protocol === 'anthropic' ? body.output_config?.effort : body.reasoning_effort, effort === 'auto' ? undefined : effort);
        return Response.json(protocol === 'anthropic'
          ? { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal fixture', signature: 'opaque-signature' }, { type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
          : { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      });
      const result = await provider.complete({ system: 's', messages: [], tools: [], maxTokens: 100 });
      if (protocol === 'anthropic') assert.deepEqual(result.message.content[0], { type: 'thinking', thinking: 'internal fixture', signature: 'opaque-signature' });
    }
  }
});

test('session effort migrates safely, persists, and helpers inherit model and effort', async () => {
  const root = await temporary();
  let store = new Store(join(root, 'sessions.sqlite'));
  try {
    const session = store.create({ cwd: root, provider: 'test', model: 'old', effort: 'high', permissionMode: 'read-only' });
    store.append(session.id, { role: 'user', content: [{ type: 'text', text: 'Original context.' }] });
    store.db.exec('ALTER TABLE sessions DROP COLUMN effort; ALTER TABLE requests DROP COLUMN requestedEffort; PRAGMA user_version=3;');
    store.close(); store = new Store(join(root, 'sessions.sqlite'));
    assert.equal(store.get(session.id).effort, 'auto');
    store.update(session.id, { model: 'new-model', effort: 'xhigh' });
    const config = validateConfig({ ...defaults, tmpDir: root, dataDir: root, provider: 'test', providers: { test: { protocol: 'anthropic', auth: 'none', apiKeyEnv: '', model: 'old', baseUrl: 'https://example.com/v1', pricing: { inputUsdPerMTok: 100 } } } });
    let first = true;
    const agent = new PuppyAgent({ config, store, tmpDir: root, approve: async () => false, providerFactory: s => ({ models: async () => ['new-model'], complete: async (): Promise<Completion> => {
      assert.equal(s.effort, 'xhigh'); assert.equal(s.model, 'new-model');
      if (!s.parentId && first) { first = false; return { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'spawn', name: 'spawn_puppy', input: { name: 'Scout', task: 'inspect' } }] }, inputTokens: 1, outputTokens: 1, stopReason: 'tool_use' }; }
      return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
    } }) });
    await agent.run(session.id, 'delegate');
    const records = store.requests(session.id);
    assert.ok(records.every(r => r.requestedEffort === 'xhigh'));
    assert.ok(records.every(r => r.pricing === null), 'Rates for the old model must not price the new model.');
    assert.equal(store.messages(session.id)[0].content[0].type, 'text');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('the packaged JavaScript runs inside node_modules and excludes private environment files', async () => {
  const root = await temporary();
  try {
    const target = join(root, 'node_modules', 'puppy-agent');
    await buildPackage(resolve('.'), target);
    await assert.rejects(stat(join(target, '.env')), /ENOENT/);
    assert.ok((await readFile(join(target, 'dist', 'cli.js'), 'utf8')).includes("'./store.js'"));
    const result = await run([join(target, 'bin', 'puppy.mjs'), '--version'], root);
    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes(currentVersion));
    assert.doesNotMatch(result.output, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('global installer and local updater preserve user settings and work from another directory', async () => {
  const root = await temporary();
  try {
    const source = join(root, 'source');
    await buildPackage(resolve('.'), source);
    await writeFile(join(source, '.env'), 'KIE_API_KEY=fixture-only-not-real\n');
    const tmpDir = join(root, 'tmp'), settings = join(root, 'settings');
    await mkdir(tmpDir); await mkdir(settings);
    const env = { PUPPY_ENV_FILE: join(settings, '.env'), PUPPY_CONFIG: join(settings, 'config.json'), PUPPY_TMP_DIR: tmpDir, PUPPY_MODEL: 'claude-opus-5-5', PUPPY_EFFORT: 'medium', npm_config_cache: join(tmpDir, 'npm-cache') };
    const prefix = join(root, 'prefix');
    const install = await run(['--experimental-strip-types', resolve('src/cli.ts'), 'install', '--source', source, '--prefix', prefix], root, env);
    assert.equal(install.code, 0, install.output);
    assert.doesNotMatch(install.output, /fixture-only-not-real/);
    const executable = join(prefix, process.platform === 'win32' ? 'puppy.cmd' : 'bin/puppy');
    const version = await run([executable, '--version'], root, env);
    assert.equal(version.code, 0, version.output); assert.ok(version.output.includes(currentVersion));
    const savedConfig = await readFile(env.PUPPY_CONFIG, 'utf8');
    const savedEnv = await readFile(env.PUPPY_ENV_FILE, 'utf8');
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const parts = currentVersion.split('.').map(Number); parts[2]++;
    pkg.version = parts.join('.'); await writeFile(join(source, 'package.json'), JSON.stringify(pkg));
    const update = await run([executable, 'update', '--local'], root, env);
    assert.equal(update.code, 0, update.output);
    const updated = await run([executable, '--version'], root, env);
    assert.ok(updated.output.includes(pkg.version));
    assert.equal(await readFile(env.PUPPY_CONFIG, 'utf8'), savedConfig);
    assert.equal(await readFile(env.PUPPY_ENV_FILE, 'utf8'), savedEnv);
    assert.equal(newerVersion('0.3.0', '0.2.1'), true);
    assert.equal(newerVersion('0.1.0', '0.2.0'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
