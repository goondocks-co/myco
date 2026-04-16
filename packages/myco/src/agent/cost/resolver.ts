import { estimateOpenAICost } from './openai.js';
import { estimateOpenRouterCost } from './openrouter.js';
import type { CostResolution, CostResolutionInput } from './types.js';
import { buildTokenBreakdown } from './breakdown.js';

function resolveActualCost(input: CostResolutionInput): CostResolution | null {
  if (input.usage.costUsd === undefined || input.usage.costUsd === null) return null;
  return {
    source: 'actual',
    costUsd: input.usage.costUsd,
    actualCostUsd: input.usage.costUsd,
    estimatedCostUsd: null,
    breakdown: {
      ...buildTokenBreakdown(input.usage),
      totalCostUsd: input.usage.costUsd,
    },
    pricingVersion: null,
  };
}

function resolveUnavailable(input: CostResolutionInput, message?: string): CostResolution {
  return {
    source: 'unavailable',
    costUsd: null,
    actualCostUsd: null,
    estimatedCostUsd: null,
    breakdown: buildTokenBreakdown(input.usage),
    pricingVersion: null,
    message: message ?? null,
  };
}

export async function resolveCost(input: CostResolutionInput): Promise<CostResolution> {
  const actual = resolveActualCost(input);
  if (actual) return actual;

  switch (input.provider?.type) {
    case 'openai':
      return estimateOpenAICost(input.model, input.usage);
    case 'openrouter':
      return estimateOpenRouterCost(input.model, input.usage, input.provider.baseUrl);
    case 'anthropic':
      return resolveUnavailable(input, 'Anthropic runtime did not report cost for this run');
    case 'openai-compatible':
    case 'ollama':
    case 'lmstudio':
      return resolveUnavailable(input, 'No pricing resolver configured for this provider');
    default:
      return resolveUnavailable(input, 'No provider cost resolver available');
  }
}
