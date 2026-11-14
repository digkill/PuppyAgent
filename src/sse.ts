import type { JsonObject } from './types.ts';

export async function* sse(response: Response, signal?: AbortSignal): AsyncGenerator<{ event: string; data: JsonObject }> {
  if (!response.body) throw new Error('Streaming response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
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
      const { done, value } = await reader.read();
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
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
