/**
 * What a run's spend resolves to.
 *
 * A harness reports what it can: Claude Code a dollar figure, Codex and the
 * protocol harnesses token counts alone. The resolution carries the counts in
 * every case and a figure where one is known or can be priced, and says which.
 */

/** Where the figure came from: the harness said it, a price table derived it, or nobody knows. */
export type CostSource = 'actual' | 'estimated' | 'unavailable';

/** The token counts a harness reported for one run, every field optional. */
export interface RunUsage {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  durationMs?: number;
  costUsd?: number | null;
}

export interface CostBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requestCount: number;
  inputCostUsd?: number;
  cachedInputCostUsd?: number;
  outputCostUsd?: number;
  reasoningCostUsd?: number;
  requestCostUsd?: number;
  totalCostUsd?: number;
  cacheSavingsUsd?: number;
}

export interface CostResolution {
  source: CostSource;
  costUsd: number | null;
  actualCostUsd: number | null;
  estimatedCostUsd: number | null;
  breakdown: CostBreakdown;
  pricingVersion?: string | null;
  message?: string | null;
  providerMetadata?: Record<string, unknown>;
}

/** The provider a run's model is reached through, and what pricing it needs. */
export interface CostProvider {
  type: string;
  baseUrl?: string;
  /** The Deployment's key for a provider whose price list is read live. */
  apiKey?: string;
}

export interface CostResolutionInput {
  harness: string;
  model: string;
  usage: RunUsage;
  provider?: CostProvider;
}

export interface CostProviderResolver {
  id: string;
  matches: (input: CostResolutionInput) => boolean;
  resolve: (input: CostResolutionInput) => Promise<CostResolution>;
}
