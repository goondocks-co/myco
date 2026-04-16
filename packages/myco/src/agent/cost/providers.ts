import { estimateOpenAICost } from './openai.js';
import { estimateOpenRouterCost } from './openrouter.js';
import { resolveUnavailableCost } from './helpers.js';
import type { ProviderType } from '@myco/agent/types.js';
import type { CostProviderCapabilities, CostProviderResolver, CostResolutionInput } from './types.js';

const CAPABILITIES_NONE: CostProviderCapabilities = {
  estimateFromUsage: false,
  fetchActualRunCost: false,
  fetchCatalogPricing: false,
};

const CAPABILITIES_ANTHROPIC: CostProviderCapabilities = {
  estimateFromUsage: false,
  fetchActualRunCost: true,
  fetchCatalogPricing: false,
};

const CAPABILITIES_OPENAI: CostProviderCapabilities = {
  estimateFromUsage: true,
  fetchActualRunCost: false,
  fetchCatalogPricing: false,
};

const CAPABILITIES_OPENROUTER: CostProviderCapabilities = {
  estimateFromUsage: true,
  fetchActualRunCost: true,
  fetchCatalogPricing: true,
};

const UNAVAILABLE_PROVIDER_RULES: Array<{
  providerTypes: ProviderType[];
  message: string;
}> = [
  {
    providerTypes: ['anthropic'],
    message: 'Anthropic runtime did not report cost for this run',
  },
  {
    providerTypes: ['openai-compatible', 'ollama', 'lmstudio'],
    message: 'No pricing resolver configured for this provider',
  },
];

function matchesProviderType(providerType: ProviderType | undefined, candidates: ProviderType[]): boolean {
  return providerType !== undefined && candidates.includes(providerType);
}

const COST_PROVIDERS: CostProviderResolver[] = [
  {
    id: 'openai',
    capabilities: CAPABILITIES_OPENAI,
    matches: (input) => input.provider?.type === 'openai',
    resolve: async (input) => estimateOpenAICost(input.model, input.usage),
  },
  {
    id: 'openrouter',
    capabilities: CAPABILITIES_OPENROUTER,
    matches: (input) => input.provider?.type === 'openrouter',
    resolve: async (input) => estimateOpenRouterCost(input.model, input.usage, input.provider?.baseUrl),
  },
  {
    id: 'anthropic-runtime',
    capabilities: CAPABILITIES_ANTHROPIC,
    matches: (input) => input.provider?.type === 'anthropic',
    resolve: async (input) => resolveUnavailableCost(input, 'Anthropic runtime did not report cost for this run'),
  },
  {
    id: 'generic-configured',
    capabilities: CAPABILITIES_NONE,
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
  for (const rule of UNAVAILABLE_PROVIDER_RULES) {
    if (matchesProviderType(input.provider?.type, rule.providerTypes)) {
      return resolveUnavailableCost(input, rule.message);
    }
  }
  return resolveUnavailableCost(input, 'No provider cost resolver available');
}
