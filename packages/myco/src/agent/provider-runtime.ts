import type { ProviderType, RuntimeId } from './types.js';
import {
  DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS,
  DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS,
  DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS,
} from './context-windows.js';

interface ProviderMetadata {
  runtime: RuntimeId;
  defaultContextWindowTokens?: number;
}

const PROVIDER_METADATA_BY_TYPE: Record<ProviderType, ProviderMetadata> = {
  anthropic: {
    runtime: 'claude-sdk',
    defaultContextWindowTokens: DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS,
  },
  ollama: {
    runtime: 'claude-sdk',
    defaultContextWindowTokens: DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS,
  },
  lmstudio: {
    runtime: 'claude-sdk',
    defaultContextWindowTokens: DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS,
  },
  openai: {
    runtime: 'openai-agents',
    defaultContextWindowTokens: DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS,
  },
  openrouter: {
    runtime: 'openai-agents',
    defaultContextWindowTokens: DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS,
  },
  'openai-compatible': {
    runtime: 'openai-agents',
    defaultContextWindowTokens: DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS,
  },
};

export function getProviderMetadata(providerType: ProviderType | undefined): ProviderMetadata | undefined {
  if (!providerType) return undefined;
  return PROVIDER_METADATA_BY_TYPE[providerType];
}

export function inferRuntimeFromProviderType(providerType: ProviderType | undefined): RuntimeId | undefined {
  return getProviderMetadata(providerType)?.runtime;
}

export function inferDefaultContextWindowFromProviderType(providerType: ProviderType | undefined): number | null {
  return getProviderMetadata(providerType)?.defaultContextWindowTokens ?? null;
}
