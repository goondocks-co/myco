import type { ProviderType, RuntimeId } from './types.js';

const PROVIDER_RUNTIME_BY_TYPE: Record<ProviderType, RuntimeId> = {
  anthropic: 'claude-sdk',
  ollama: 'claude-sdk',
  lmstudio: 'claude-sdk',
  openai: 'openai-agents',
  openrouter: 'openai-agents',
  'openai-compatible': 'openai-agents',
};

export function inferRuntimeFromProviderType(providerType: ProviderType | undefined): RuntimeId | undefined {
  if (!providerType) return undefined;
  return PROVIDER_RUNTIME_BY_TYPE[providerType];
}
