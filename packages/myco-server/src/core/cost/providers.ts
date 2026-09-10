import { resolveUnavailableCost } from './helpers.js';
import { estimateOpenAICost } from './openai.js';
import { estimateOpenRouterCost } from './openrouter.js';
import type { CostProviderResolver, CostResolutionInput } from './types.js';

/** Every provider a run's model may be reached through, and how each one's spend is priced. */
const COST_PROVIDERS: readonly CostProviderResolver[] = [
  {
    id: 'openai',
    matches: (input) => input.provider?.type === 'openai',
    resolve: async (input) => estimateOpenAICost(input.model, input.usage),
  },
  {
    id: 'openrouter',
    matches: (input) => input.provider?.type === 'openrouter',
    resolve: async (input) => estimateOpenRouterCost(input.model, input.usage, { baseUrl: input.provider?.baseUrl, apiKey: input.provider?.apiKey }),
  },
  {
    id: 'anthropic-harness',
    matches: (input) => input.provider?.type === 'anthropic',
    resolve: async (input) => resolveUnavailableCost(input, 'Anthropic harness did not report cost for this run'),
  },
  {
    id: 'generic-configured',
    matches: (input) => ['openai-compatible', 'ollama', 'lmstudio'].includes(input.provider?.type ?? ''),
    resolve: async (input) => resolveUnavailableCost(input, 'No pricing resolver configured for this provider'),
  },
];

/** The resolver for this run's provider, or null for a provider nothing here prices. */
export function getCostProvider(input: CostResolutionInput): CostProviderResolver | null {
  return COST_PROVIDERS.find((provider) => provider.matches(input)) ?? null;
}

export function resolveProviderCostUnavailable(input: CostResolutionInput) {
  return resolveUnavailableCost(input, 'No provider cost resolver available');
}
