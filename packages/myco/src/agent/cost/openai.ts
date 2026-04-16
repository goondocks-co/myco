import type { CostResolution } from './types.js';
import type { RuntimeUsage } from '@myco/agent/types.js';
import { buildTokenBreakdown } from './breakdown.js';

const TOKENS_PER_MILLION = 1_000_000;
const OPENAI_PRICING_VERSION = 'openai-api-pricing-2026-04-16';

interface OpenAIPricing {
  model: string;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

const OPENAI_PRICING_RULES: Array<{
  matches: (model: string) => boolean;
  pricing: OpenAIPricing;
}> = [
  {
    matches: (model) => model === 'gpt-5.4',
    pricing: {
      model: 'gpt-5.4',
      inputUsdPerMillion: 2.5,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
    },
  },
  {
    matches: (model) => model === 'gpt-5.4-mini',
    pricing: {
      model: 'gpt-5.4-mini',
      inputUsdPerMillion: 0.75,
      cachedInputUsdPerMillion: 0.075,
      outputUsdPerMillion: 4.5,
    },
  },
  {
    matches: (model) => model === 'gpt-5.4-nano',
    pricing: {
      model: 'gpt-5.4-nano',
      inputUsdPerMillion: 0.2,
      cachedInputUsdPerMillion: 0.02,
      outputUsdPerMillion: 1.25,
    },
  },
];

function findPricing(model: string): OpenAIPricing | null {
  for (const rule of OPENAI_PRICING_RULES) {
    if (rule.matches(model)) return rule.pricing;
  }
  return null;
}

function tokensToUsd(tokens: number, usdPerMillion: number): number {
  return (tokens * usdPerMillion) / TOKENS_PER_MILLION;
}

export function estimateOpenAICost(model: string, usage: RuntimeUsage): CostResolution {
  const breakdown = buildTokenBreakdown(usage);
  const pricing = findPricing(model);
  if (!pricing) {
    return {
      source: 'unavailable',
      costUsd: null,
      actualCostUsd: null,
      estimatedCostUsd: null,
      breakdown,
      pricingVersion: OPENAI_PRICING_VERSION,
      message: `No built-in pricing table entry for ${model}`,
    };
  }

  const inputCostUsd = tokensToUsd(breakdown.uncachedInputTokens, pricing.inputUsdPerMillion);
  const cachedInputCostUsd = tokensToUsd(breakdown.cachedInputTokens, pricing.cachedInputUsdPerMillion);
  const outputCostUsd = tokensToUsd(breakdown.outputTokens, pricing.outputUsdPerMillion);
  const totalCostUsd = inputCostUsd + cachedInputCostUsd + outputCostUsd;
  const cacheSavingsUsd = tokensToUsd(
    breakdown.cachedInputTokens,
    pricing.inputUsdPerMillion - pricing.cachedInputUsdPerMillion,
  );

  return {
    source: 'estimated',
    costUsd: totalCostUsd,
    actualCostUsd: null,
    estimatedCostUsd: totalCostUsd,
    breakdown: {
      ...breakdown,
      inputCostUsd,
      cachedInputCostUsd,
      outputCostUsd,
      totalCostUsd,
      cacheSavingsUsd,
    },
    pricingVersion: OPENAI_PRICING_VERSION,
    providerMetadata: {
      model: pricing.model,
      inputUsdPerMillion: pricing.inputUsdPerMillion,
      cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion,
      outputUsdPerMillion: pricing.outputUsdPerMillion,
    },
  };
}
