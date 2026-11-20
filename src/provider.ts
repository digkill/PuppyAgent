import type { Block, Completion, CompletionRequest, JsonObject, Message, IncompleteToolCall, Provider, ProviderConfig, RequestMetrics } from './types.ts';
import { count, metricsFromResponse } from './usage.ts';
import { sse, StreamIdleTimeout } from './sse.ts';
import { checkEffort, isArgolink, isKie, KIE_GEMINI_MODELS, routeProvider } from './provider-routing.ts';

type Fetch = typeof globalThis.fetch;
function clientRequestId(response: Response): string | null {
  const value = response.headers.get('x-client-request-id');
  return value && /^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|req_[A-Za-z0-9_-]{1,100})$/i.test(value) ? value : null;
}
class RequestTimeout extends Error {
  constructor(timeoutMs: number) { super(`Provider request exceeded ${timeoutMs} ms total. Set PUPPY_REQUEST_TIMEOUT_MS to adjust. Partial tools were not executed; use /continue to inspect and resume.`); }
}
class HttpFailure extends Error {
  clientRequestId: string | null;
  constructor(message: string, id: string | null) { super(message); this.clientRequestId = id; }
}
function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} from provider.`);
  return value as JsonObject;
}
export class ProviderFailure extends Error {
  metrics: RequestMetrics;
  constructor(message: string, metrics: RequestMetrics) { super(message); this.metrics = metrics; }
}
/** Send alternating turns, including all results of a tool batch in one user turn.
 * Anthropic accepts adjacent same-role messages, but some compatible gateways fail on them.
 * The canonical SQL messages are left untouched.
 */
export function anthropicHistory(messages: Message[]): { role: Message['role']; content: string | Block[] }[] {
  const turns: Message[] = [];
  for (const message of messages) {
    const previous = turns.at(-1);
    if (previous?.role === message.role) previous.content.push(...message.content);
    else turns.push({ role: message.role, content: [...message.content] });
  }
  return turns.map(turn => ({
    role: turn.role,
    content: turn.content.length && turn.content.every(b => b.type === 'text')
      ? turn.content.map(b => b.type === 'text' ? b.text : '').join('\n\n')
      : turn.content,
  }));
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
export function textOnlyHistory(messages: Message[]): Message[] {
  return messages.map(m => ({ role: m.role, content: [{ type: 'text', text: m.content.flatMap(b => {
    if (b.type === 'text') return [b.text];
    if (b.type === 'tool_use') return [`[Earlier tool request ${b.name} (${b.id}): ${JSON.stringify(b.input)}]`];
    if (b.type === 'tool_result') return [`[Earlier tool result ${b.tool_use_id}: ${b.content}]`];
    return [];
  }).join('\n') || '[Earlier non-text assistant response]' }] }));
}
function checkApiCode(response: JsonObject): void {
  if (typeof response.code === 'number' && response.code !== 200 && response.code !== 0) throw new Error(`Provider API code ${response.code} (HTTP 200). Check model, route and provider logs. No automatic retry.`);
}
export class HttpProvider implements Provider {
  config: ProviderConfig;
  timeoutMs: number;
  fetcher: Fetch;
  streamIdleTimeoutMs: number;
  responseTimeouts = new WeakMap<Response, { signal: AbortSignal; deadline: AbortSignal }>();
  constructor(config: ProviderConfig, timeoutMs = 900000, fetcher: Fetch = globalThis.fetch, streamIdleTimeoutMs = 180000) {
    this.config = routeProvider(config); this.timeoutMs = timeoutMs; this.fetcher = fetcher; this.streamIdleTimeoutMs = streamIdleTimeoutMs;
  }
  async http(path: string, body?: unknown, signal?: AbortSignal, exactUrl?: string): Promise<Response> {
    const cfg = this.config;
    const key = process.env[cfg.apiKeyEnv];
    if (cfg.auth !== 'none' && !key) throw new Error(`Set environment variable ${cfg.apiKeyEnv}.`);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.auth === 'bearer') headers.authorization = `Bearer ${key}`;
    if (cfg.auth === 'x-api-key') headers['x-api-key'] = key!;
    if (cfg.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
    let response: Response;
    try { response = await this.fetcher(exactUrl || `${cfg.baseUrl.replace(/\/$/, '')}/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: combined,
      redirect: 'error', // Never forward credentials to a redirected endpoint.
    }); } catch (error) {
      if (deadline.aborted && !signal?.aborted) throw new RequestTimeout(this.timeoutMs);
      if (!combined.aborted && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(cfg.baseUrl).hostname)) throw new Error(`Local model server unavailable at ${new URL(cfg.baseUrl).host}. Start Ollama or LM Studio and check PUPPY_BASE_URL.`);
      throw error;
    }
    this.responseTimeouts.set(response, { signal: combined, deadline });
    if (!response.ok) {
      // Provider bodies may echo secrets or full prompts. Do not persist or print them.
      let code = '';
      if (isArgolink(cfg)) {
        try {
          const body = await response.json() as JsonObject;
          const allowed = ['API_KEY_REQUIRED', 'INVALID_API_KEY', 'API_KEY_DISABLED', 'API_KEY_EXPIRED', 'ACCESS_DENIED', 'API_KEY_READ_ONLY', 'INSUFFICIENT_BALANCE', 'API_KEY_QUOTA_EXHAUSTED', 'RATE_LIMITED'];
          if (typeof body.code === 'string' && allowed.includes(body.code)) code = ` (${body.code})`;
        } catch { /* Never echo untrusted provider text. */ }
      } else await response.body?.cancel();
      const id = clientRequestId(response);
      throw new HttpFailure(`Provider HTTP ${response.status}${code}.${id ? ` Request ID: ${id}.` : ''} Check endpoint, model, balance and provider logs. Request was not automatically retried.`, id);
    }
    return response;
  }
  async request(path: string, body?: unknown, signal?: AbortSignal, exactUrl?: string): Promise<JsonObject> {
    const result = object(await (await this.http(path, body, signal, exactUrl)).json(), 'response');
    checkApiCode(result); return result;
  }
  async models(signal?: AbortSignal): Promise<string[]> {
    const data = await this.request('models', undefined, signal, this.config.modelsUrl);
    if (!Array.isArray(data.data)) throw new Error('Expected models response with a data array.');
    const ids = data.data.map(m => object(m, 'model').id).filter((m): m is string => typeof m === 'string');
    return [...new Set([...ids, ...(isKie(this.config) && this.config.routing !== 'fixed' ? KIE_GEMINI_MODELS : [])])];
  }
  assertCompatible(request: CompletionRequest): void {
    checkEffort(this.config);
    if (request.tools.length && this.config.supportsTools === false) throw new Error('This provider route is documented as chat-only. Function calling is unavailable; no API request was sent.');
  }
  async complete(req: CompletionRequest): Promise<Completion> {
    const started = performance.now();
    let res: JsonObject = {};
    const incompleteToolCalls: IncompleteToolCall[] = [];
    let streamed = false;
    let requestId: string | null = null;
    let responseDeadline: AbortSignal | undefined;
    const metrics = (): RequestMetrics => ({ ...metricsFromResponse(res, this.config.protocol, this.config.model, Math.round(performance.now() - started), streamed), clientRequestId: requestId });
    try {
    this.assertCompatible(req);
    if (!this.config.model || this.config.model.startsWith('REPLACE_')) throw new Error('Set an actual model ID in your provider config. Use: puppy models');
    if (this.config.protocol === 'anthropic') {
      const raw = await this.http('messages', {
        model: this.config.model, max_tokens: req.maxTokens,
        system: isArgolink(this.config) && this.config.promptCache && this.config.promptCache !== 'off' ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral', ttl: this.config.promptCache } }] : req.system,
        stream: Boolean(this.config.stream),
        ...(this.config.effort && this.config.effort !== 'auto' ? { output_config: { effort: this.config.effort } } : {}),
        ...(!isArgolink(this.config) && this.config.promptCache && this.config.promptCache !== 'off' ? { cache_control: { type: 'ephemeral', ttl: this.config.promptCache } } : {}),
        messages: anthropicHistory(req.messages),
        ...(req.tools.length ? { tools: req.tools } : {}),
      }, req.signal);
      responseDeadline = this.responseTimeouts.get(raw)?.deadline;
      requestId = clientRequestId(raw);
      if (raw.headers.get('content-type')?.includes('text/event-stream')) {
        streamed = true;
        await this.anthropicStream(raw, req, res, incompleteToolCalls);
      } else res = object(await raw.json(), 'response');
      checkApiCode(res);
      if (res.role !== 'assistant' || !Array.isArray(res.content)) throw new Error('Invalid Anthropic response.');
      const content: Block[] = res.content.map(value => {
        const b = object(value, 'content block');
        if (b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: b.text };
        if (b.type === 'thinking' && typeof b.thinking === 'string' && typeof b.signature === 'string') return { type: 'thinking', thinking: b.thinking, signature: b.signature };
        if (b.type === 'redacted_thinking' && typeof b.data === 'string') return { type: 'redacted_thinking', data: b.data };
        if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') return { type: 'tool_use', id: b.id, name: b.name, input: object(b.input, 'tool input') };
        throw new Error(`Unsupported Anthropic block: ${String(b.type)}. This version supports text and client tool use.`);
      });
      const m = metrics();
      return { ...(incompleteToolCalls.length ? { incompleteToolCalls } : {}), message: { role: 'assistant', content }, inputTokens: m.usage.inputTokens ?? count(m.rawUsage.input_tokens) ?? 0, outputTokens: m.usage.outputTokens ?? 0, stopReason: String(res.stop_reason || ''), metrics: m };
    }
    const raw = await this.http('chat/completions', {
      model: this.config.model, [this.config.maxTokensParameter || 'max_completion_tokens']: req.maxTokens,
      stream: Boolean(this.config.stream),
      ...(this.config.stream && this.config.streamUsage !== false ? { stream_options: { include_usage: true } } : {}),
      ...(this.config.effort && this.config.effort !== 'auto' ? { reasoning_effort: this.config.effort } : {}),
      messages: [{ role: 'system', content: req.system }, ...openAIHistory(this.config.supportsTools === false ? textOnlyHistory(req.messages) : req.messages)],
      ...(req.tools.length ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
    }, req.signal);
    responseDeadline = this.responseTimeouts.get(raw)?.deadline;
    requestId = clientRequestId(raw);
    if (raw.headers.get('content-type')?.includes('text/event-stream')) {
      streamed = true; await this.openAIStream(raw, req, res);
    } else res = object(await raw.json(), 'response');
    checkApiCode(res);
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
        try { content.push({ type: 'tool_use', id: call.id, name: fn.name, input: object(JSON.parse(fn.arguments), 'tool arguments') }); }
        catch (error) {
          if (choice.finish_reason !== 'length') throw error;
          incompleteToolCalls.push({ id: call.id, name: fn.name, partialJson: fn.arguments });
          content.push({ type: 'text', text: `Incomplete tool request ${fn.name} was NOT executed: response token limit reached.` });
        }
      }
    }
    const mtr = metrics();
    return { ...(incompleteToolCalls.length ? { incompleteToolCalls } : {}), message: { role: 'assistant', content }, inputTokens: mtr.usage.inputTokens ?? 0, outputTokens: mtr.usage.outputTokens ?? 0, stopReason: String(choice.finish_reason || ''), metrics: mtr };
    } catch (error) {
      if (error instanceof HttpFailure) requestId = error.clientRequestId;
      const m = metrics();
      if (error instanceof StreamIdleTimeout) m.failureKind = 'stream-idle-timeout';
      else if (error instanceof RequestTimeout || responseDeadline?.aborted && !req.signal?.aborted) { error = new RequestTimeout(this.timeoutMs); m.failureKind = 'request-timeout'; }
      else if (req.signal?.aborted) m.failureKind = 'cancelled';
      throw new ProviderFailure((error as Error).message, m);
    }
  }
  async openAIStream(raw: Response, req: CompletionRequest, result: JsonObject): Promise<void> {
    let text = '', refusal = '', reason = '', done = false;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const record of sse(raw, this.responseTimeouts.get(raw)?.signal || req.signal, this.streamIdleTimeoutMs)) {
      if (record.event === 'done') { done = true; break; }
      const event = record.data;
      checkApiCode(event);
      if (event.error) throw new Error('Provider emitted an OpenAI streaming error. Partial usage retained; tools were not executed.');
      if (typeof event.id === 'string') result.id = event.id;
      if (typeof event.model === 'string') result.model = event.model;
      if (event.usage) result.usage = { ...object(result.usage || {}, 'usage'), ...object(event.usage, 'usage') };
      if (event.credits_consumed !== undefined) result.credits_consumed = event.credits_consumed;
      if (!Array.isArray(event.choices)) continue;
      for (const rawChoice of event.choices) {
        const choice = object(rawChoice, 'stream choice');
        if (choice.index !== undefined && choice.index !== 0) continue;
        if (typeof choice.finish_reason === 'string') reason = choice.finish_reason;
        const delta = object(choice.delta || {}, 'stream delta');
        if (typeof delta.content === 'string') { text += delta.content; req.onTextDelta?.(delta.content); }
        if (typeof delta.refusal === 'string') refusal += delta.refusal;
        if (Array.isArray(delta.tool_calls)) for (const value of delta.tool_calls) {
          const call = object(value, 'stream tool call'), index = call.index;
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 15) throw new Error('Invalid streamed tool index.');
          const target = calls.get(index) || { id: '', name: '', arguments: '' };
          if (typeof call.id === 'string') target.id += call.id;
          const fn = object(call.function || {}, 'stream function');
          if (typeof fn.name === 'string') target.name += fn.name;
          if (typeof fn.arguments === 'string') target.arguments += fn.arguments;
          if (target.arguments.length > 8 * 1024 * 1024) throw new Error('Streamed tool arguments too large.');
          calls.set(index, target);
        }
      }
      if (text.length + refusal.length > 8 * 1024 * 1024) throw new Error('Streamed response too large.');
    }
    // Kie's chat-only Gemini endpoint currently omits finish_reason, but does send
    // final usage/credits followed by [DONE]. Never relax this rule for tool calls.
    if (done && !reason && !calls.size && this.config.supportsTools === false) reason = 'gateway_done';
    if (!done || !reason) throw new Error('Incomplete OpenAI stream. Partial tool calls were not executed.');
    result.choices = [{ finish_reason: reason, message: { role: 'assistant', content: text || null, ...(refusal ? { refusal } : {}), ...(calls.size ? { tool_calls: [...calls].sort(([a], [b]) => a - b).map(([, call]) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } })) } : {}) } }];
  }
  async anthropicStream(raw: Response, req: CompletionRequest, result: JsonObject, incompleteToolCalls: IncompleteToolCall[] = []): Promise<void> {
    const blocks = new Map<number, { block: JsonObject; json: string; stopped: boolean }>();
    let started = false, stopped = false;
    for await (const record of sse(raw, this.responseTimeouts.get(raw)?.signal || req.signal, this.streamIdleTimeoutMs)) {
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
        if (!['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(String(block.type))) throw new Error(`Unsupported streaming block: ${String(block.type)}`);
        if (block.type === 'text') {
          if ([...blocks.values()].some(b => b.block.type === 'text')) req.onTextDelta?.('\n');
          if (typeof block.text === 'string' && block.text) req.onTextDelta?.(block.text);
        }
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
        } else if (delta.type === 'thinking_delta' && target.block.type === 'thinking' && typeof delta.thinking === 'string') {
          target.block.thinking = String(target.block.thinking || '') + delta.thinking;
        } else if (delta.type === 'signature_delta' && target.block.type === 'thinking' && typeof delta.signature === 'string') {
          target.block.signature = String(target.block.signature || '') + delta.signature;
        } else throw new Error('Unsupported SSE content delta.');
        if (target.json.length + JSON.stringify(target.block).length > 8 * 1024 * 1024) throw new Error('Streamed content block too large.');
      } else if (type === 'content_block_stop') {
        const target = blocks.get(event.index as number);
        if (!target || target.stopped) throw new Error('SSE stop without an open block.');
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
    result.content = [...blocks].sort(([a], [b]) => a - b).map(([, b]) => {
      if (b.block.type === 'tool_use' && b.json) {
        try { b.block.input = object(JSON.parse(b.json), 'stream tool input'); }
        catch (error) {
          if (result.stop_reason !== 'max_tokens') throw error;
          incompleteToolCalls.push({ id: String(b.block.id || ''), name: String(b.block.name || ''), partialJson: b.json });
          return { type: 'text', text: `Incomplete tool request ${String(b.block.name)} was NOT executed: response token limit reached.` };
        }
      }
      return b.block;
    });
  }
}
