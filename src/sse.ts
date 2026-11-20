import type { JsonObject } from './types.ts';

export class StreamIdleTimeout extends Error {
  constructor(timeoutMs: number) { super(`Provider stream sent no data for ${timeoutMs} ms. Set PUPPY_STREAM_IDLE_TIMEOUT_MS to adjust. Partial tools were not executed; use /continue to inspect and resume.`); }
}

export async function* sse(response: Response, signal?: AbortSignal, idleTimeoutMs = 180000): AsyncGenerator<{ event: string; data: JsonObject }> {
  if (!response.body) throw new Error('Streaming response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  function readChunk(): Promise<ReadableStreamReadResult<Uint8Array>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true; cleanup(); reject(reason);
        // Cancel immediately, but a broken transport must not hold cancellation hostage.
        void reader.cancel(reason).catch(() => {});
      };
      const abort = () => fail(signal?.reason || new Error('Cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      timer = setTimeout(() => fail(new StreamIdleTimeout(idleTimeoutMs)), idleTimeoutMs);
      reader.read().then(value => {
        if (settled) return;
        settled = true; cleanup(); resolve(value);
      }, fail);
    });
  }

  let buffer = '', event = '', data: string[] = [];
  function line(value: string): { event: string; data: JsonObject } | null {
    if (value === '') {
      if (!data.length) { event = ''; return null; }
      const payload = data.join('\n');
      const current = event;
      event = ''; data = [];
      if (payload.trim() === '[DONE]') return { event: 'done', data: {} };
      const raw: unknown = JSON.parse(payload);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid SSE data object.');
      return { event: current, data: raw as JsonObject };
    }
    if (value.startsWith('event:')) event = value.slice(6).trim();
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    return null;
  }
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await readChunk();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const part = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        const record = line(part);
        if (record) yield record;
      }
      if (buffer.length + data.reduce((n, v) => n + v.length, 0) > 8 * 1024 * 1024) throw new Error('SSE event too large.');
      if (done) {
        // An unterminated event is not committed. The caller must observe message_stop.
        break;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
