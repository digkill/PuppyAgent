import type { Effort, ProviderConfig } from './types.ts';

export const KIE_GEMINI_MODELS = ['gemini-4-carbon-openai'];
export function isArgolink(config: ProviderConfig): boolean { return new URL(config.baseUrl).hostname === 'argolink.io'; }
const argoPrices: Record<string, [number, number, number, number]> = {
  'claude-opus-5-5': [1.4, 7, 0.07, 1.75],
  'claude-sonnet-5-5': [0.7, 3.5, 0.035, 0.875],
  'claude-fable-5-2': [2.8, 14, 0.07, 3.5],
};
export function isKie(config: ProviderConfig): boolean { return new URL(config.baseUrl).hostname === 'api.kie.ai'; }
export function routeProvider(config: ProviderConfig, model = config.model, effort: Effort = config.effort || 'auto'): ProviderConfig {
  const result = { ...config, model, effort, pricing: config.model === model ? config.pricing : undefined };
  if (config.routing === 'fixed') return result;
  if (isArgolink(config)) {
    const claude = model.startsWith('claude-');
    const prices = argoPrices[model];
    return { ...result, protocol: claude ? 'anthropic' : 'openai-chat', baseUrl: config.baseUrl, modelsUrl: config.modelsUrl || `${config.baseUrl.replace(/\/$/, '')}/models`,
      supportsTools: config.supportsTools ?? true, supportsEffort: claude, effortLevels: claude ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] : ['auto'],
      promptCache: claude ? config.promptCache : 'off', maxTokensParameter: 'max_completion_tokens',
      pricing: config.model === model && config.pricing ? config.pricing : prices ? { inputUsdPerMTok: prices[0], outputUsdPerMTok: prices[1], cacheReadUsdPerMTok: prices[2], cacheWrite5mUsdPerMTok: prices[3], cacheWrite1hUsdPerMTok: prices[0] * 2, source: `https://argolink.io/en/models/${model}`, asOf: '2026-11-14' } : undefined,
    };
  }
  if (!isKie(config)) return result;
  if (!model || model.startsWith('REPLACE_')) return result;
  if (model.startsWith('claude-')) {
    return { ...result, protocol: 'anthropic', baseUrl: 'https://api.kie.ai/claude/v1', modelsUrl: 'https://api.kie.ai/anthropic/v1/models', supportsTools: config.supportsTools ?? true };
  }
  if (KIE_GEMINI_MODELS.includes(model)) {
    return { ...result, protocol: 'openai-chat', baseUrl: `https://api.kie.ai/${model}/v1`, modelsUrl: 'https://api.kie.ai/anthropic/v1/models', supportsTools: config.supportsTools ?? false, supportsEffort: true, effortLevels: ['auto', 'low', 'medium', 'high'], promptCache: 'off', maxTokensParameter: 'max_tokens', streamUsage: false };
  }
  throw new Error(`No verified Kie route for ${model}. Configure a fixed provider with its documented protocol and baseUrl.`);
}
export function checkEffort(config: ProviderConfig): void {
  const effort = config.effort || 'auto';
  if (effort !== 'auto' && config.supportsEffort === false) throw new Error('This provider profile has no verified effort control. Set PUPPY_EFFORT=auto or use --effort auto.');
  if (config.effortLevels && !config.effortLevels.includes(effort)) throw new Error(`This route supports effort: ${config.effortLevels.join(', ')}.`);
}
