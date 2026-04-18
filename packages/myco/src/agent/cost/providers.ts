import { estimateOpenAICost } from './openai.js';
import { estimateOpenRouterCost } from './openrouter.js';
import { resolveUnavailableCost } from './helpers.js';
import type { ProviderType } from '@myco/agent/types.js';
import type { CostProviderResolver, CostResolutionInput } from './types.js';

function matchesProviderType(providerType: ProviderType | undefined, candidates: ProviderType[]): boolean {
  return providerType !== undefined && candidates.includes(providerType);
}

const COST_PROVIDERS: CostProviderResolver[] = [
  {
    id: 'openai',
    matches: (input) => input.provider?.type === 'openai',
    resolve: async (input) => estimateOpenAICost(input.model, input.usage),
  },
  {
    id: 'openrouter',
    matches: (input) => input.provider?.type === 'openrouter',
    resolve: async (input) => estimateOpenRouterCost(input.model, input.usage, input.provider?.baseUrl),
  },
  {
    id: 'anthropic-runtime',
    matches: (input) => input.provider?.type === 'anthropic',
    resolve: async (input) => resolveUnavailableCost(input, 'Anthropic runtime did not report cost for this run'),
  },
  {
    id: 'generic-configured',
    matches: (input) => matchesProviderType(input.provider?.type, ['openai-compatible', 'ollama', 'lmstudio']),
    resolve: async (input) => resolveUnavailableCost(input, 'No pricing resolver configured for this provider'),
  },
];

export function getCostProvider(input: CostResolutionInput): CostProviderResolver | null {
  for (const provider of COST_PROVIDERS) {
    if (provider.matches(input)) {
      return provider;
    }
  }
  return null;
}

export function resolveProviderCostUnavailable(input: CostResolutionInput) {
  return resolveUnavailableCost(input, 'No provider cost resolver available');
}
