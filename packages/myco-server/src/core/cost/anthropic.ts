import { buildTokenBreakdown } from './breakdown.js';
import type { CostResolution, RunUsage } from './types.js';

const PRICING_VERSION = 'anthropic-api-pricing-2026-10-01';
const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const PER_MILLION = 1_000_000;
/** Standard global API list rates; subscription allowances and negotiated charges are not billing evidence. */
const PRICES: Readonly<Record<string, { input: number; cached: number; output: number }>> = {
  'claude-sonnet-4-6': { input: 3, cached: 0.3, output: 15 },
  'claude-opus-4-6': { input: 5, cached: 0.5, output: 25 },
  'claude-haiku-4-5-20251001': { input: 1, cached: 0.1, output: 5 },
};

/** Cache writes require their TTL to price; an undifferentiated write count stays unavailable. */
export function estimateAnthropicCost(model: string, usage: RunUsage): CostResolution {
  const breakdown = buildTokenBreakdown(usage);
  const price = PRICES[model];
  const base = { breakdown, pricingVersion: PRICING_VERSION, providerMetadata: { model, pricingSource: PRICING_URL } };
  if (price === undefined || (usage.cacheCreationTokens ?? 0) > 0) return {
    ...base, source: 'unavailable', costUsd: null, actualCostUsd: null, estimatedCostUsd: null,
    message: 'Exact model price or cache-write TTL accounting is unavailable',
  };
  const inputCostUsd = breakdown.uncachedInputTokens * price.input / PER_MILLION;
  const cachedInputCostUsd = breakdown.cachedInputTokens * price.cached / PER_MILLION;
  const outputCostUsd = breakdown.outputTokens * price.output / PER_MILLION;
  const costUsd = inputCostUsd + cachedInputCostUsd + outputCostUsd;
  return {
    ...base, source: 'estimated', costUsd, actualCostUsd: null, estimatedCostUsd: costUsd,
    breakdown: { ...breakdown, inputCostUsd, cachedInputCostUsd, outputCostUsd, totalCostUsd: costUsd },
    message: 'Standard global API list-price estimate; not a subscription charge or billing statement',
  };
}
