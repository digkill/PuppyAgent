import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { defaults, environmentDefaults, validateConfig } from '../src/config.ts';
import { HttpProvider, ProviderFailure } from '../src/provider.ts';
import { PuppyAgent } from '../src/agent.ts';
import { Store } from '../src/store.ts';
import type { CompletionRequest, JsonObject, ProviderConfig } from '../src/types.ts';

const base = process.env.PUPPY_TEST_TMP;
if (!base) throw new Error('Set PUPPY_TEST_TMP explicitly.');
const config: ProviderConfig = { protocol: 'anthropic', baseUrl: 'https://example.com/v1', auth: 'none', apiKeyEnv: '', model: 'test', stream: true };
const req = (): CompletionRequest => ({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'work' }] }], tools: [], maxTokens: 4096 });
function frames(): JsonObject[] {
  return [
    { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, credits_consumed: 0.25 } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...Array.from({ length: 6 }, () => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
    { type: 'message_stop' },
  ];
}
function delayed(events: JsonObject[], interval: number, stall = false): Response {
  let index = 0, timer: ReturnType<typeof setTimeout>;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        if (index < events.length) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(events[index++])}\n\n`));
          timer = setTimeout(send, interval);
        } else if (!stall) controller.close();
      };
      send();
    },
    cancel() { clearTimeout(timer); },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('active streams reset the idle timer for every chunk instead of using idle time as total duration', async () => {
  const provider = new HttpProvider(config, 3000, async () => delayed(frames(), 20), 90);
  const result = await provider.complete(req());
  assert.equal(result.message.content[0].type, 'text');
  assert.equal((result.message.content[0] as { text: string }).text, 'xxxxxx');
  assert.equal(result.metrics?.creditsConsumed, 0.25);
});

test('stalled SSE is cancelled promptly even if transport cancellation never resolves', async () => {
  let cancelled = false;
  const provider = new HttpProvider(config, 3000, async () => new Response(new ReadableStream({
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  }), { headers: { 'content-type': 'text/event-stream' } }), 35);
  await assert.rejects(provider.complete(req()), error => {
    assert.ok(error instanceof ProviderFailure);
    assert.equal(error.metrics.failureKind, 'stream-idle-timeout');
    assert.match(error.message, /PUPPY_STREAM_IDLE_TIMEOUT_MS/);
    return true;
  });
  assert.equal(cancelled, true);
});

test('the total deadline still stops an active endless stream and retains partial usage', async () => {
  const provider = new HttpProvider(config, 100, async () => delayed(frames().slice(0, 8), 15, true), 90);
  await assert.rejects(provider.complete(req()), error => {
    assert.ok(error instanceof ProviderFailure);
    assert.equal(error.metrics.failureKind, 'request-timeout');
    assert.equal(error.metrics.creditsConsumed, 0.25);
    assert.match(error.message, /100 ms total/);
    return true;
  });
});

test('user cancellation interrupts a waiting stream without being classified as a timeout', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const provider = new HttpProvider(config, 3000, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }), 1000);
  const timer = setTimeout(() => controller.abort(new Error('User cancelled')), 25);
  try {
    await assert.rejects(provider.complete({ ...req(), signal: controller.signal }), error => {
      assert.ok(error instanceof ProviderFailure);
      assert.equal(error.metrics.failureKind, 'cancelled');
      assert.match(error.message, /User cancelled/);
      return true;
    });
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});

test('native fetch header stalls are bounded by the configured request deadline', async () => {
  const server = createServer((_request, _response) => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const provider = new HttpProvider({ ...config, baseUrl: `http://127.0.0.1:${address.port}/v1` }, 80);
    await assert.rejects(provider.complete(req()), error => {
      assert.ok(error instanceof ProviderFailure);
      assert.equal(error.metrics.failureKind, 'request-timeout');
      assert.equal(error.metrics.streamed, false);
      return true;
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('timed out partial tool streams never execute or automatically replay and preserve their attempt ledger', async () => {
  await mkdir(base!, { recursive: true });
  const root = await mkdtemp(join(base!, 'timeout-'));
  const store = new Store(join(root, 'sessions.sqlite'));
  let requests = 0;
  try {
    const cfg = validateConfig({ ...defaults, tmpDir: root, dataDir: root, provider: 'test', goalCompletionCheck: true, providers: { test: config } });
    const session = store.create({ cwd: root, provider: 'test', model: 'test', permissionMode: 'workspace-write' });
    const events = [frames()[0],
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'partial', name: 'write_file', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"unsafe.txt","content":"never run"}' } },
      { type: 'content_block_stop', index: 0 },
    ];
    const agent = new PuppyAgent({ config: cfg, store, tmpDir: root, approve: async () => false, providerFactory: () => new HttpProvider(config, 3000, async () => { requests++; return delayed(events, 1, true); }, 35) });
    await assert.rejects(agent.run(session.id, 'Write the file'), /no data/);
    await assert.rejects(stat(join(root, 'unsafe.txt')), { code: 'ENOENT' });
    assert.equal(requests, 1);
    const rows = store.requests(session.id);
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].metrics?.failureKind, 'stream-idle-timeout');
    assert.equal(rows[0].metrics?.creditsConsumed, 0.25);
    assert.equal(store.latestTask(session.id)?.status, 'failed');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('timeout env settings are independently validated and do not mutate the underlying config', () => {
  const names = ['PUPPY_REQUEST_TIMEOUT_MS', 'PUPPY_STREAM_IDLE_TIMEOUT_MS', 'PUPPY_COMMAND_TIMEOUT_MS'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, { PUPPY_REQUEST_TIMEOUT_MS: '900000', PUPPY_STREAM_IDLE_TIMEOUT_MS: '180000', PUPPY_COMMAND_TIMEOUT_MS: '240000' });
    const cfg = validateConfig({ ...defaults, tmpDir: base });
    const selected = environmentDefaults(cfg);
    assert.equal(selected.requestTimeoutMs, 900000); assert.equal(selected.streamIdleTimeoutMs, 180000); assert.equal(selected.commandTimeoutMs, 240000);
    assert.equal(cfg.commandTimeoutMs, defaults.commandTimeoutMs);
    for (const name of names) {
      const value = process.env[name];
      for (const invalid of ['0', '-1', 'NaN', '1.5']) { process.env[name] = invalid; assert.throws(() => environmentDefaults(cfg), /positive integer/); }
      process.env[name] = '2147483648'; assert.throws(() => environmentDefaults(cfg), /at most/);
      process.env[name] = value;
    }
  } finally { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});
