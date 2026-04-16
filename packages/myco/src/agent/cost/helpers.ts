import { buildTokenBreakdown } from './breakdown.js';
import type { CostResolution, CostResolutionInput } from './types.js';

export function resolveActualCost(input: CostResolutionInput): CostResolution | null {
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

export function resolveUnavailableCost(
  input: CostResolutionInput,
  message?: string,
): CostResolution {
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
