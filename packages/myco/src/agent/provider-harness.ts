import type { ProviderType, HarnessId } from './types.js';
import {
  DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS,
  DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS,
  DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS,
} from './context-windows.js';

/**
 * Per-provider-type metadata: which harness is the default, which harnesses
 * the provider can run on, and the context-window token budget to assume
 * when the provider doesn't report one.
 *
 * Single source of truth — imported by the daemon for `/providers` API
 * responses and by the UI to drive provider/harness selectors. Adding a
 * new harness for an existing provider type is a one-line edit here.
 */
export interface ProviderMetadata {
  harness: HarnessId;
  supportedHarnesses: readonly HarnessId[];
  defaultContextWindowTokens?: number;
}

export const PROVIDER_METADATA_BY_TYPE: Record<ProviderType, ProviderMetadata> = {
  anthropic: {
    harness: 'claude-sdk',
    supportedHarnesses: ['claude-sdk'],
    defaultContextWindowTokens: DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS,
  },
  ollama: {
    harness: 'claude-sdk',
    supportedHarnesses: ['claude-sdk', 'openai-agents'],
    defaultContextWindowTokens: DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS,
  },
  lmstudio: {
    harness: 'claude-sdk',
    supportedHarnesses: ['claude-sdk', 'openai-agents'],
    defaultContextWindowTokens: DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS,
  },
  openai: {
    harness: 'openai-agents',
    supportedHarnesses: ['openai-agents'],
    defaultContextWindowTokens: DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS,
  },
  openrouter: {
    harness: 'openai-agents',
    supportedHarnesses: ['openai-agents'],
    defaultContextWindowTokens: DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS,
  },
  'openai-compatible': {
    harness: 'openai-agents',
    supportedHarnesses: ['openai-agents'],
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

export function getSupportedHarnessesForProviderType(
  providerType: ProviderType | undefined,
): readonly HarnessId[] {
  return getProviderMetadata(providerType)?.supportedHarnesses ?? [];
}

export function providerTypeSupportsHarness(
  providerType: ProviderType | undefined,
  harnessId: HarnessId | undefined,
): boolean {
  if (!providerType || !harnessId) return false;
  return getSupportedHarnessesForProviderType(providerType).includes(harnessId);
}

export function inferDefaultContextWindowFromProviderType(providerType: ProviderType | undefined): number | null {
  return getProviderMetadata(providerType)?.defaultContextWindowTokens ?? null;
}
