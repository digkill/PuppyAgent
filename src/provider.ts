import type { Block, Completion, CompletionRequest, JsonObject, Message, Provider, ProviderConfig, RequestMetrics } from './types.ts';
import { count, metricsFromResponse } from './usage.ts';
import { sse } from './sse.ts';

type Fetch = typeof globalThis.fetch;
function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} from provider.`);
  return value as JsonObject;
}
export class ProviderFailure extends Error {
  metrics: RequestMetrics;
  constructor(message: string, metrics: RequestMetrics) { super(message); this.metrics = metrics; }
}
export function openAIHistory(messages: Message[]): JsonObject[] {
  return messages.flatMap((m): JsonObject[] => {
    const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (m.role === 'assistant') {
      const calls = m.content.filter(b => b.type === 'tool_use');
      return [{ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) }];
    }
    const out: JsonObject[] = [];
    // Tool results precede a new user instruction if both are present.
    for (const b of m.content) if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
    if (text) out.push({ role: 'user', content: text });
    return out;
  });
}
export class HttpProvider implements Provider {
  config: ProviderConfig;
  timeoutMs: number;
  fetcher: Fetch;
  constructor(config: ProviderConfig, timeoutMs = 120000, fetcher: Fetch = globalThis.fetch) {
    this.config = config; this.timeoutMs = timeoutMs; this.fetcher = fetcher;
  }
  async http(path: string, body?: unknown, signal?: AbortSignal, exactUrl?: string): Promise<Response> {
    const cfg = this.config;
    const key = process.env[cfg.apiKeyEnv];
    if (cfg.auth !== 'none' && !key) throw new Error(`Set environment variable ${cfg.apiKeyEnv}.`);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.auth === 'bearer') headers.authorization = `Bearer ${key}`;
    if (cfg.auth === 'x-api-key') headers['x-api-key'] = key!;
    if (cfg.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
    const combined = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    const response = await this.fetcher(exactUrl || `${cfg.baseUrl.replace(/\/$/, '')}/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: combined,
      redirect: 'error', // Never forward credentials to a redirected endpoint.
    });
    if (!response.ok) {
      // Provider bodies may echo secrets or full prompts. Do not persist or print them.
      await response.body?.cancel();
      throw new Error(`Provider HTTP ${response.status}. Check endpoint, model, balance and provider logs. Request was not automatically retried.`);
    }
    return response;
  }
  async request(path: string, body?: unknown, signal?: AbortSignal, exactUrl?: string): Promise<JsonObject> {
    return object(await (await this.http(path, body, signal, exactUrl)).json(), 'response');
  }
  async models(signal?: AbortSignal): Promise<string[]> {
    const data = await this.request('models', undefined, signal, this.config.modelsUrl);
    if (!Array.isArray(data.data)) throw new Error('Expected models response with a data array.');
    return data.data.map(m => object(m, 'model').id).filter((m): m is string => typeof m === 'string');
  }
  async complete(req: CompletionRequest): Promise<Completion> {
    const started = performance.now();
    let res: JsonObject = {};
    let streamed = false;
    const metrics = () => metricsFromResponse(res, this.config.protocol, this.config.model, Math.round(performance.now() - started), streamed);
    try {
    if (!this.config.model || this.config.model.startsWith('REPLACE_')) throw new Error('Set an actual model ID in your provider config. Use: npm start -- models');
    if (this.config.protocol === 'anthropic') {
      const raw = await this.http('messages', {
        model: this.config.model, max_tokens: req.maxTokens, system: req.system,
        stream: Boolean(this.config.stream),
        ...(this.config.promptCache && this.config.promptCache !== 'off' ? { cache_control: { type: 'ephemeral', ttl: this.config.promptCache } } : {}),
        messages: req.messages.map(({ role, content }) => ({ role, content })),
        ...(req.tools.length ? { tools: req.tools } : {}),
      }, req.signal);
      if (raw.headers.get('content-type')?.includes('text/event-stream')) {
        streamed = true;
        await this.anthropicStream(raw, req, res);
      } else res = object(await raw.json(), 'response');
      if (res.role !== 'assistant' || !Array.isArray(res.content)) throw new Error('Invalid Anthropic response.');
      const content: Block[] = res.content.map(value => {
        const b = object(value, 'content block');
        if (b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: b.text };
        if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') return { type: 'tool_use', id: b.id, name: b.name, input: object(b.input, 'tool input') };
        throw new Error(`Unsupported Anthropic block: ${String(b.type)}. This version supports text and client tool use.`);
      });
      const m = metrics();
      return { message: { role: 'assistant', content }, inputTokens: m.usage.inputTokens ?? count(m.rawUsage.input_tokens) ?? 0, outputTokens: m.usage.outputTokens ?? 0, stopReason: String(res.stop_reason || ''), metrics: m };
    }
    res = await this.request('chat/completions', {
      model: this.config.model, max_completion_tokens: req.maxTokens,
      messages: [{ role: 'system', content: req.system }, ...openAIHistory(req.messages)],
      ...(req.tools.length ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
    }, req.signal);
    if (!Array.isArray(res.choices) || !res.choices.length) throw new Error('Missing provider choices.');
    const choice = object(res.choices[0], 'choice');
    const m = object(choice.message, 'message');
    const content: Block[] = [];
    if (typeof m.content === 'string' && m.content) content.push({ type: 'text', text: m.content });
    if (typeof m.refusal === 'string') content.push({ type: 'text', text: m.refusal });
    if (m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls)) throw new Error('Invalid tool_calls.');
      for (const raw of m.tool_calls) {
        const call = object(raw, 'tool call');
        const fn = object(call.function, 'function');
        if (typeof call.id !== 'string' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') throw new Error('Invalid tool call fields.');
        content.push({ type: 'tool_use', id: call.id, name: fn.name, input: object(JSON.parse(fn.arguments), 'tool arguments') });
      }
    }
    const mtr = metrics();
    return { message: { role: 'assistant', content }, inputTokens: mtr.usage.inputTokens ?? 0, outputTokens: mtr.usage.outputTokens ?? 0, stopReason: String(choice.finish_reason || ''), metrics: mtr };
    } catch (error) {
      throw new ProviderFailure((error as Error).message, metrics());
    }
  }
  async anthropicStream(raw: Response, req: CompletionRequest, result: JsonObject): Promise<void> {
    const blocks = new Map<number, { block: JsonObject; json: string; stopped: boolean }>();
    let started = false, stopped = false;
    for await (const record of sse(raw, req.signal)) {
      const event = record.data, type = event.type || record.event;
      // Some gateways put billing information on their final event rather than message_start.
      if (event.credits_consumed !== undefined) result.credits_consumed = event.credits_consumed;
      if (event.usage && typeof event.usage === 'object') result.usage = { ...object(result.usage || {}, 'usage'), ...object(event.usage, 'usage') };
      if (type === 'error') throw new Error('Provider emitted a streaming error. Partial usage was retained; tools were not executed.');
      if (type === 'message_start') {
        if (started) throw new Error('Duplicate SSE message_start.');
        started = true;
        const message = object(event.message, 'stream message');
        Object.assign(result, message);
      } else if (type === 'content_block_start') {
        if (!started || !Number.isInteger(event.index) || blocks.has(event.index as number)) throw new Error('Invalid SSE block start.');
        const block = object(event.content_block, 'stream content block');
        if (!['text', 'tool_use'].includes(String(block.type))) throw new Error(`Unsupported streaming block: ${String(block.type)}`);
        blocks.set(event.index as number, { block: { ...block }, json: '', stopped: false });
      } else if (type === 'content_block_delta') {
        const target = blocks.get(event.index as number);
        if (!target || target.stopped) throw new Error('SSE delta without an open block.');
        const delta = object(event.delta, 'stream delta');
        if (delta.type === 'text_delta' && target.block.type === 'text' && typeof delta.text === 'string') {
          target.block.text = String(target.block.text || '') + delta.text;
          req.onTextDelta?.(delta.text);
        } else if (delta.type === 'input_json_delta' && target.block.type === 'tool_use' && typeof delta.partial_json === 'string') {
          target.json += delta.partial_json;
        } else throw new Error('Unsupported SSE content delta.');
        if (target.json.length + String(target.block.text || '').length > 8 * 1024 * 1024) throw new Error('Streamed content block too large.');
      } else if (type === 'content_block_stop') {
        const target = blocks.get(event.index as number);
        if (!target || target.stopped) throw new Error('SSE stop without an open block.');
        if (target.block.type === 'tool_use' && target.json) target.block.input = object(JSON.parse(target.json), 'stream tool input');
        target.stopped = true;
      } else if (type === 'message_delta') {
        const delta = object(event.delta || {}, 'message delta');
        if (delta.stop_reason !== undefined) result.stop_reason = delta.stop_reason;
        if (delta.credits_consumed !== undefined) result.credits_consumed = delta.credits_consumed;
      } else if (type === 'message_stop') {
        if (!started || [...blocks.values()].some(b => !b.stopped)) throw new Error('SSE message stopped with incomplete blocks.');
        stopped = true;
        break;
      } else if (type !== 'ping') throw new Error(`Unsupported SSE event: ${String(type)}`);
    }
    if (!stopped || !result.stop_reason) throw new Error('Incomplete provider stream. Partial output is not executable; inspect usage before retrying.');
    result.content = [...blocks].sort(([a], [b]) => a - b).map(([, b]) => b.block);
  }
}
