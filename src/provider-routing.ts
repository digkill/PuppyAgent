import type { Effort, ProviderConfig } from './types.ts';

export const KIE_GEMINI_MODELS = ['gemini-4-carbon-openai'];
export function isKie(config: ProviderConfig): boolean { return new URL(config.baseUrl).hostname === 'api.kie.ai'; }
export function routeProvider(config: ProviderConfig, model = config.model, effort: Effort = config.effort || 'auto'): ProviderConfig {
  const result = { ...config, model, effort };
  if (!isKie(config) || config.routing === 'fixed') return result;
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
