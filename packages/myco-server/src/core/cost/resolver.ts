import { resolveActualCost } from './helpers.js';
import { getCostProvider, resolveProviderCostUnavailable } from './providers.js';
import type { CostResolution, CostResolutionInput } from './types.js';

/** The run's spend: the harness's own figure where it gave one, else a priced estimate, else the counts alone. */
export async function resolveCost(input: CostResolutionInput): Promise<CostResolution> {
  const actual = resolveActualCost(input);
  if (actual !== null) return actual;
  const provider = getCostProvider(input);
  return provider === null ? resolveProviderCostUnavailable(input) : provider.resolve(input);
}
