import { buildTokenBreakdown } from './breakdown.js';
import { resolveActualCost } from './helpers.js';
import { getCostProvider, resolveProviderCostUnavailable } from './providers.js';
import type { CostResolution, CostResolutionInput } from './types.js';

/** Actual charges take precedence over reported estimates, provider pricing and unavailable cost. */
export async function resolveCost(input: CostResolutionInput): Promise<CostResolution> {
  const actual = resolveActualCost(input);
  if (actual !== null) return actual;
  if (input.usage.estimatedCostUsd != null) {
    return {
      source: 'estimated', costUsd: input.usage.estimatedCostUsd, actualCostUsd: null,
      estimatedCostUsd: input.usage.estimatedCostUsd,
      breakdown: { ...buildTokenBreakdown(input.usage), totalCostUsd: input.usage.estimatedCostUsd },
      message: 'Estimate reported by the harness; not a billing statement',
    };
  }
  const provider = getCostProvider(input);
  return provider === null ? resolveProviderCostUnavailable(input) : provider.resolve(input);
}
