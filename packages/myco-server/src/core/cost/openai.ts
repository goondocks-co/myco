import { buildTokenBreakdown } from './breakdown.js';
import type { CostResolution, RunUsage } from './types.js';

const TOKENS_PER_MILLION = 1_000_000;
const OPENAI_PRICING_VERSION = 'openai-api-pricing-2026-04-16';

interface OpenAIPricing {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

/** The published list prices, by model id, as of the version named above. */
const OPENAI_PRICING: Readonly<Record<string, OpenAIPricing>> = {
  'gpt-5.4': { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
  'gpt-5.4-mini': { inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 },
  'gpt-5.4-nano': { inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.25 },
};

const tokensToUsd = (tokens: number, usdPerMillion: number): number => (tokens * usdPerMillion) / TOKENS_PER_MILLION;

/** A figure from the built-in OpenAI price table, or the counts alone for a model the table does not name. */
export function estimateOpenAICost(model: string, usage: RunUsage): CostResolution {
  const breakdown = buildTokenBreakdown(usage);
  const pricing = OPENAI_PRICING[model];
  if (pricing === undefined) {
    return {
      source: 'unavailable', costUsd: null, actualCostUsd: null, estimatedCostUsd: null, breakdown,
      pricingVersion: OPENAI_PRICING_VERSION, message: `No built-in pricing table entry for ${model}`,
    };
  }
  const inputCostUsd = tokensToUsd(breakdown.uncachedInputTokens, pricing.inputUsdPerMillion);
  const cachedInputCostUsd = tokensToUsd(breakdown.cachedInputTokens, pricing.cachedInputUsdPerMillion);
  const outputCostUsd = tokensToUsd(breakdown.outputTokens, pricing.outputUsdPerMillion);
  const totalCostUsd = inputCostUsd + cachedInputCostUsd + outputCostUsd;
  // Clamped at zero: a cached rate above the uncached one is a saving of nothing, never a cost.
  const cacheSavingsUsd = Math.max(0, tokensToUsd(breakdown.cachedInputTokens, pricing.inputUsdPerMillion - pricing.cachedInputUsdPerMillion));
  return {
    source: 'estimated',
    costUsd: totalCostUsd,
    actualCostUsd: null,
    estimatedCostUsd: totalCostUsd,
    breakdown: { ...breakdown, inputCostUsd, cachedInputCostUsd, outputCostUsd, totalCostUsd, cacheSavingsUsd },
    pricingVersion: OPENAI_PRICING_VERSION,
    providerMetadata: { model, ...pricing },
  };
}
