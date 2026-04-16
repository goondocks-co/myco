import type { ProviderConfig, RuntimeUsage } from '@myco/agent/types.js';

export type CostSource = 'actual' | 'estimated' | 'unavailable';

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

export interface CostResolutionInput {
  runtime: string;
  model: string;
  usage: RuntimeUsage;
  provider?: ProviderConfig;
}
