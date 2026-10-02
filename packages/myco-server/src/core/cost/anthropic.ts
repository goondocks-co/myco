import { buildTokenBreakdown } from './breakdown.js';
import type { CostResolution, RunUsage } from './types.js';

const PRICING_VERSION = 'anthropic-api-pricing-2026-10-01';
const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const PER_MILLION = 1_000_000;
interface Price { input: number; cached: number; write5m: number; write1h: number; output: number }
/** Standard global API rates; each cache category has its own rate. */
const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5-5': { input: 4, cached: 0.2, write5m: 5, write1h: 8, output: 20 },
  'claude-sonnet-5-5': { input: 2, cached: 0.2, write5m: 2.5, write1h: 4, output: 10 },
  'claude-haiku-4-5': { input: 1, cached: 0.1, write5m: 1.25, write1h: 2, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, cached: 0.1, write5m: 1.25, write1h: 2, output: 5 },
  'claude-sonnet-4-6': { input: 3, cached: 0.3, write5m: 3.75, write1h: 6, output: 15 },
  'claude-opus-4-6': { input: 5, cached: 0.5, write5m: 6.25, write1h: 10, output: 25 },
};

/** Cache writes require reported TTL counts; missing write evidence stays unavailable. */
export function estimateAnthropicCost(model: string, usage: RunUsage, context?: '1m'): CostResolution {
  const breakdown = buildTokenBreakdown(usage);
  const price = PRICES[model];
  const writes = usage.cacheCreationTokens;
  const write5m = usage.cacheCreation5mTokens ?? (writes === 0 ? 0 : undefined);
  const write1h = usage.cacheCreation1hTokens ?? (writes === 0 ? 0 : undefined);
  const base = { breakdown, pricingVersion: PRICING_VERSION, providerMetadata: { model, ...(context === undefined ? {} : { context }), pricingTier: 'standard', pricingSource: PRICING_URL } };
  if (price === undefined || usage.inputTokens == null || usage.outputTokens == null || usage.cachedTokens == null || writes == null || write5m == null || write1h == null
    || write5m + write1h !== writes || usage.cachedTokens + writes > usage.inputTokens) return {
    ...base, source: 'unavailable', costUsd: null, actualCostUsd: null, estimatedCostUsd: null,
    message: 'Exact model price or complete cache accounting is unavailable',
  };
  const uncachedInputTokens = usage.inputTokens - usage.cachedTokens - writes;
  const inputCostUsd = uncachedInputTokens * price.input / PER_MILLION;
  const cachedInputCostUsd = usage.cachedTokens * price.cached / PER_MILLION;
  const cacheCreation5mCostUsd = write5m * price.write5m / PER_MILLION;
  const cacheCreation1hCostUsd = write1h * price.write1h / PER_MILLION;
  const outputCostUsd = usage.outputTokens * price.output / PER_MILLION;
  const costUsd = inputCostUsd + cachedInputCostUsd + cacheCreation5mCostUsd + cacheCreation1hCostUsd + outputCostUsd;
  return {
    ...base, source: 'estimated', costUsd, actualCostUsd: null, estimatedCostUsd: costUsd,
    breakdown: { ...breakdown, uncachedInputTokens, inputCostUsd, cachedInputCostUsd, cacheCreation5mCostUsd, cacheCreation1hCostUsd, outputCostUsd, totalCostUsd: costUsd },
    message: 'Standard global API list-price estimate; not a subscription charge or billing statement',
  };
}
