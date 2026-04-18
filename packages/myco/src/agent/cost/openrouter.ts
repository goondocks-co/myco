import { OPENROUTER_API_KEY_ENV } from '@myco/cli/providers/openrouter.js';
import type { CostResolution } from './types.js';
import type { RuntimeUsage } from '@myco/agent/types.js';
import { buildTokenBreakdown } from './breakdown.js';

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_MODELS_ENDPOINT = '/models';
const OPENROUTER_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const OPENROUTER_MODELS_TIMEOUT_MS = 5_000;
const OPENROUTER_PRICING_VERSION = 'openrouter-model-catalog-live';
/** Hard cap on catalog entries — prevents cache poisoning / OOM if the
 *  upstream returns a hostile or corrupt response. */
const OPENROUTER_CATALOG_MAX_ENTRIES = 10_000;

interface OpenRouterPricing {
  inputUsdPerToken?: number;
  cachedInputUsdPerToken?: number;
  outputUsdPerToken?: number;
  reasoningUsdPerToken?: number;
  requestUsd?: number;
}

interface OpenRouterCatalogEntry {
  id?: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
    image?: string;
    web_search?: string;
    internal_reasoning?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

interface OpenRouterCatalogCacheEntry {
  expiresAt: number;
  pricingByModel: Map<string, OpenRouterPricing>;
}

const catalogCache = new Map<string, OpenRouterCatalogCacheEntry>();

function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const parsed = Number(rate);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function hasAnyPricing(pricing: OpenRouterPricing): boolean {
  return [
    pricing.inputUsdPerToken,
    pricing.cachedInputUsdPerToken,
    pricing.outputUsdPerToken,
    pricing.reasoningUsdPerToken,
    pricing.requestUsd,
  ].some((value) => value !== undefined);
}

function resolveOpenRouterApiKey(): string | undefined {
  return process.env[OPENROUTER_API_KEY_ENV];
}

function resolveBaseUrl(baseUrl?: string): string {
  return baseUrl ?? OPENROUTER_DEFAULT_BASE_URL;
}

function pruneExpiredCatalogEntries(now: number): void {
  for (const [key, entry] of catalogCache) {
    if (entry.expiresAt <= now) catalogCache.delete(key);
  }
}

async function fetchPricingCatalog(baseUrl?: string): Promise<Map<string, OpenRouterPricing>> {
  const resolvedBaseUrl = resolveBaseUrl(baseUrl);
  const now = Date.now();
  const cached = catalogCache.get(resolvedBaseUrl);
  if (cached && cached.expiresAt > now) {
    return cached.pricingByModel;
  }
  pruneExpiredCatalogEntries(now);

  const apiKey = resolveOpenRouterApiKey();
  if (!apiKey) {
    throw new Error('OpenRouter API key not configured');
  }

  const response = await fetch(`${resolvedBaseUrl}${OPENROUTER_MODELS_ENDPOINT}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(OPENROUTER_MODELS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter models request failed with ${response.status}`);
  }

  const parsed = await response.json() as unknown;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { data?: unknown }).data)) {
    throw new Error('OpenRouter catalog response missing data array');
  }
  const entries = (parsed as { data: OpenRouterCatalogEntry[] }).data;
  if (entries.length > OPENROUTER_CATALOG_MAX_ENTRIES) {
    throw new Error(`OpenRouter catalog exceeded ${OPENROUTER_CATALOG_MAX_ENTRIES} entries`);
  }
  const pricingByModel = new Map<string, OpenRouterPricing>();
  for (const entry of entries) {
    if (!entry.id || !entry.pricing) continue;
    pricingByModel.set(entry.id, {
      inputUsdPerToken: parseRate(entry.pricing.prompt),
      cachedInputUsdPerToken: parseRate(entry.pricing.input_cache_read),
      outputUsdPerToken: parseRate(entry.pricing.completion),
      reasoningUsdPerToken: parseRate(entry.pricing.internal_reasoning),
      requestUsd: parseRate(entry.pricing.request),
    });
  }

  catalogCache.set(resolvedBaseUrl, {
    expiresAt: now + OPENROUTER_CATALOG_CACHE_TTL_MS,
    pricingByModel,
  });
  return pricingByModel;
}

export async function estimateOpenRouterCost(
  model: string,
  usage: RuntimeUsage,
  baseUrl?: string,
): Promise<CostResolution> {
  const breakdown = buildTokenBreakdown(usage);

  try {
    const pricingByModel = await fetchPricingCatalog(baseUrl);
    const pricing = pricingByModel.get(model);
    if (!pricing) {
      return {
        source: 'unavailable',
        costUsd: null,
        actualCostUsd: null,
        estimatedCostUsd: null,
        breakdown,
        pricingVersion: OPENROUTER_PRICING_VERSION,
        message: `No OpenRouter pricing metadata found for ${model}`,
      };
    }
    if (!hasAnyPricing(pricing)) {
      return {
        source: 'unavailable',
        costUsd: null,
        actualCostUsd: null,
        estimatedCostUsd: null,
        breakdown,
        pricingVersion: OPENROUTER_PRICING_VERSION,
        message: `OpenRouter pricing unavailable for ${model}`,
      };
    }

    const inputCostUsd = (pricing.inputUsdPerToken ?? 0) * breakdown.uncachedInputTokens;
    const cachedInputCostUsd = (pricing.cachedInputUsdPerToken ?? 0) * breakdown.cachedInputTokens;
    const outputCostUsd = (pricing.outputUsdPerToken ?? 0) * breakdown.outputTokens;
    const reasoningCostUsd = (pricing.reasoningUsdPerToken ?? 0) * breakdown.reasoningTokens;
    const requestCostUsd = (pricing.requestUsd ?? 0) * breakdown.requestCount;
    const totalCostUsd = inputCostUsd + cachedInputCostUsd + outputCostUsd + reasoningCostUsd + requestCostUsd;
    const cacheSavingsUsd = Math.max(0, ((pricing.inputUsdPerToken ?? 0) - (pricing.cachedInputUsdPerToken ?? 0)) * breakdown.cachedInputTokens);

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
        reasoningCostUsd,
        requestCostUsd,
        totalCostUsd,
        cacheSavingsUsd,
      },
      pricingVersion: OPENROUTER_PRICING_VERSION,
      providerMetadata: {
        inputUsdPerToken: pricing.inputUsdPerToken,
        cachedInputUsdPerToken: pricing.cachedInputUsdPerToken,
        outputUsdPerToken: pricing.outputUsdPerToken,
        reasoningUsdPerToken: pricing.reasoningUsdPerToken,
        requestUsd: pricing.requestUsd,
      },
    };
  } catch (error) {
    return {
      source: 'unavailable',
      costUsd: null,
      actualCostUsd: null,
      estimatedCostUsd: null,
      breakdown,
      pricingVersion: OPENROUTER_PRICING_VERSION,
      message: error instanceof Error ? error.message : 'OpenRouter pricing lookup failed',
    };
  }
}
