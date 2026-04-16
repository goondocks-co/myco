import type { ProviderConfig, ReasoningLevel } from './types.js';

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = 'default';

export function resolveReasoningModel(
  reasoningLevel: ReasoningLevel | undefined,
  provider: ProviderConfig | undefined,
  fallbackModel: string,
): string {
  const level = reasoningLevel ?? DEFAULT_REASONING_LEVEL;
  return provider?.reasoningMap?.[level]
    ?? provider?.model
    ?? fallbackModel;
}

