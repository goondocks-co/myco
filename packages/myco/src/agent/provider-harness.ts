import type { ProviderType, HarnessId } from './types.js';
import {
  DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS,
  DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS,
  DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS,
} from './context-windows.js';

interface ProviderMetadata {
  harness: HarnessId;
  defaultContextWindowTokens?: number;
}

const PROVIDER_METADATA_BY_TYPE: Record<ProviderType, ProviderMetadata> = {
  anthropic: {
    harness: 'claude-sdk',
    defaultContextWindowTokens: DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS,
  },
  ollama: {
    harness: 'claude-sdk',
    defaultContextWindowTokens: DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS,
  },
  lmstudio: {
    harness: 'claude-sdk',
    defaultContextWindowTokens: DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS,
  },
  openai: {
    harness: 'openai-agents',
    defaultContextWindowTokens: DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS,
  },
  openrouter: {
    harness: 'openai-agents',
    defaultContextWindowTokens: DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS,
  },
  'openai-compatible': {
    harness: 'openai-agents',
    defaultContextWindowTokens: DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS,
  },
};

export function getProviderMetadata(providerType: ProviderType | undefined): ProviderMetadata | undefined {
  if (!providerType) return undefined;
  return PROVIDER_METADATA_BY_TYPE[providerType];
}

export function inferHarnessFromProviderType(providerType: ProviderType | undefined): HarnessId | undefined {
  return getProviderMetadata(providerType)?.harness;
}

export function inferDefaultContextWindowFromProviderType(providerType: ProviderType | undefined): number | null {
  return getProviderMetadata(providerType)?.defaultContextWindowTokens ?? null;
}
