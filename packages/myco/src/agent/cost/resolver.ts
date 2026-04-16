import { resolveActualCost } from './helpers.js';
import { getCostProvider, resolveProviderCostUnavailable } from './providers.js';
import type { CostResolution, CostResolutionInput } from './types.js';

export async function resolveCost(input: CostResolutionInput): Promise<CostResolution> {
  const actual = resolveActualCost(input);
  if (actual) return actual;
  const provider = getCostProvider(input);
  if (!provider) {
    return resolveProviderCostUnavailable(input);
  }
  return provider.resolve(input);
}
