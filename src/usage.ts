import type { JsonObject, Pricing, RequestMetrics, RequestRecord, TokenUsage } from './types.ts';

export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
export function normalizeUsage(raw: JsonObject, protocol: 'anthropic' | 'openai-chat'): TokenUsage {
  const output = count(protocol === 'anthropic' ? raw.output_tokens : raw.completion_tokens);
  if (protocol === 'anthropic') {
    const input = count(raw.input_tokens), read = count(raw.cache_read_input_tokens), write = count(raw.cache_creation_input_tokens);
    const creation = raw.cache_creation && typeof raw.cache_creation === 'object' ? raw.cache_creation as JsonObject : {};
    const five = count(creation.ephemeral_5m_input_tokens), hour = count(creation.ephemeral_1h_input_tokens);
    return {
      inputTokens: input === null || read === null || write === null ? null : input + read + write, uncachedInputTokens: input, outputTokens: output,
      cacheReadInputTokens: read, cacheCreationInputTokens: write,
      cacheWrite5mInputTokens: five, cacheWrite1hInputTokens: hour,
    };
  }
  const details = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object' ? raw.prompt_tokens_details as JsonObject : {};
  const input = count(raw.prompt_tokens), cached = count(details.cached_tokens);
  return {
    inputTokens: input, uncachedInputTokens: input !== null && cached !== null && cached <= input ? input - cached : null,
    outputTokens: output, cacheReadInputTokens: cached, cacheCreationInputTokens: null,
    cacheWrite5mInputTokens: null, cacheWrite1hInputTokens: null,
  };
}
export function metricsFromResponse(response: JsonObject, protocol: 'anthropic' | 'openai-chat', model: string, latencyMs: number, streamed: boolean): RequestMetrics {
  const rawUsage = response.usage && typeof response.usage === 'object' && !Array.isArray(response.usage) ? response.usage as JsonObject : {};
  return {
    usage: normalizeUsage(rawUsage, protocol), rawUsage, creditsConsumed: amount(response.credits_consumed),
    responseId: typeof response.id === 'string' ? response.id : null,
    model: typeof response.model === 'string' ? response.model : model, latencyMs, streamed,
  };
}
export function estimateUsd(usage: TokenUsage, pricing?: Pricing): number | null {
  if (!pricing) return null;
  // Without a complete cache breakdown, unknown usage is not priced as zero.
  if (usage.cacheReadInputTokens === null || usage.uncachedInputTokens === null || usage.outputTokens === null) return null;
  const creation = usage.cacheCreationInputTokens;
  if (creation === null) return null;
  let five = usage.cacheWrite5mInputTokens, hour = usage.cacheWrite1hInputTokens;
  if (creation === 0) { five ??= 0; hour ??= 0; }
  if (five === null || hour === null || five + hour !== creation) return null;
  const components: [number, number | undefined][] = [
    [usage.uncachedInputTokens, pricing.inputUsdPerMTok], [usage.outputTokens, pricing.outputUsdPerMTok],
    [usage.cacheReadInputTokens, pricing.cacheReadUsdPerMTok], [five, pricing.cacheWrite5mUsdPerMTok], [hour, pricing.cacheWrite1hUsdPerMTok],
  ];
  if (components.some(([tokens, price]) => tokens > 0 && price === undefined)) return null;
  return components.reduce((sum, [tokens, price]) => sum + tokens * (price ?? 0) / 1e6, 0);
}
export function summarizeUsage(records: RequestRecord[]) {
  const sum = (get: (r: RequestRecord) => number | null | undefined) => {
    const known = records.map(get).filter((v): v is number => typeof v === 'number');
    return { reported: known.reduce((a, b) => a + b, 0), requestsReported: known.length, requestsUnknown: records.length - known.length };
  };
  const tokens = Object.fromEntries((['inputTokens', 'uncachedInputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'cacheWrite5mInputTokens', 'cacheWrite1hInputTokens'] as const).map(k => [k, sum(r => r.metrics?.usage[k])]));
  return {
    requests: records.length, completed: records.filter(r => r.status === 'completed').length,
    failed: records.filter(r => r.status === 'failed').length, pending: records.filter(r => r.status === 'pending').length,
    tokens, credits: sum(r => r.metrics?.creditsConsumed),
    estimatedTokenUsd: sum(r => r.metrics ? estimateUsd(r.metrics.usage, r.pricing ?? undefined) : null),
    creditsUsdAtConfiguredRate: sum(r => r.metrics?.creditsConsumed !== null && r.metrics?.creditsConsumed !== undefined && r.pricing?.usdPerCredit !== undefined ? r.metrics.creditsConsumed * r.pricing.usdPerCredit : null),
    summedRequestLatencyMs: sum(r => r.metrics?.latencyMs),
    note: 'All monetary values are reported subtotals with coverage, not assumed totals. Credits come from provider credits_consumed; USD uses configured rates. No guaranteed savings or account-balance attribution.',
  };
}
export function usageText(records: RequestRecord[], ru = false): string {
  const summary = summarizeUsage(records);
  const show = (name: string, value: { reported: number; requestsReported: number; requestsUnknown: number }) => `${name}: ${value.reported} (${value.requestsReported}/${records.length} ${ru ? 'запросов с данными' : 'requests reported'}${value.requestsUnknown ? ru ? '; остальные неизвестны' : '; remainder unknown' : ''})`;
  return [
    ru ? `Расход всей стаи: ${summary.requests} запросов` : `Pack usage: ${summary.requests} requests`,
    ...Object.entries(summary.tokens).map(([key, value]) => show(key, value)),
    show(ru ? 'Кредиты по данным провайдера' : 'Provider-reported credits', summary.credits),
    show(ru ? 'Оценка USD по тарифам токенов' : 'Estimated token USD', summary.estimatedTokenUsd),
    show(ru ? 'USD по настроенному курсу кредитов' : 'Credits USD at configured rate', summary.creditsUsdAtConfiguredRate),
    `completed=${summary.completed}; failed=${summary.failed}; pending=${summary.pending}`,
  ].join('\n');
}
