/**
 * OpenRouter prices, read live from its model catalogue.
 *
 * The catalogue is fetched at most once per base URL per cache window, and
 * concurrent cold reads share one request. A response that is not the shape the
 * catalogue promises, or larger than any real catalogue, is refused whole and
 * leaves the cache untouched.
 */
import { buildTokenBreakdown } from './breakdown.js';
import type { CostResolution, RunUsage } from './types.js';

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_MODELS_ENDPOINT = '/models';
const OPENROUTER_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const OPENROUTER_MODELS_TIMEOUT_MS = 5_000;
const OPENROUTER_PRICING_VERSION = 'openrouter-model-catalog-live';
/** The most entries a catalogue may carry; more is a hostile or corrupt answer. */
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
  pricing?: { prompt?: string; completion?: string; request?: string; internal_reasoning?: string; input_cache_read?: string };
}

interface OpenRouterCatalogCacheEntry {
  expiresAt: number;
  pricingByModel: Map<string, OpenRouterPricing>;
}

const catalogCache = new Map<string, OpenRouterCatalogCacheEntry>();
const inflightFetches = new Map<string, Promise<Map<string, OpenRouterPricing>>>();

/** A catalogue rate as a number, or undefined for one that is absent, unreadable or negative. */
function parseRate(rate: string | undefined): number | undefined {
  if (rate === undefined || rate === '') return undefined;
  const parsed = Number(rate);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

const hasAnyPricing = (pricing: OpenRouterPricing): boolean => Object.values(pricing).some((value) => value !== undefined);

function pruneExpiredCatalogEntries(now: number): void {
  for (const [key, entry] of catalogCache) if (entry.expiresAt <= now) catalogCache.delete(key);
}

async function fetchPricingCatalog(baseUrl: string, apiKey: string): Promise<Map<string, OpenRouterPricing>> {
  const now = Date.now();
  const cached = catalogCache.get(baseUrl);
  if (cached !== undefined && cached.expiresAt > now) return cached.pricingByModel;
  const inflight = inflightFetches.get(baseUrl);
  if (inflight !== undefined) return inflight;
  const fetching = fetchPricingCatalogUncached(baseUrl, apiKey, now).finally(() => { inflightFetches.delete(baseUrl); });
  inflightFetches.set(baseUrl, fetching);
  return fetching;
}

async function fetchPricingCatalogUncached(baseUrl: string, apiKey: string, now: number): Promise<Map<string, OpenRouterPricing>> {
  pruneExpiredCatalogEntries(now);
  const response = await fetch(`${baseUrl}${OPENROUTER_MODELS_ENDPOINT}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(OPENROUTER_MODELS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenRouter models request failed with ${response.status}`);
  const parsed = await response.json() as unknown;
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { data?: unknown }).data)) {
    throw new Error('OpenRouter catalog response missing data array');
  }
  const entries = (parsed as { data: OpenRouterCatalogEntry[] }).data;
  if (entries.length > OPENROUTER_CATALOG_MAX_ENTRIES) throw new Error(`OpenRouter catalog exceeded ${OPENROUTER_CATALOG_MAX_ENTRIES} entries`);
  const pricingByModel = new Map<string, OpenRouterPricing>();
  for (const entry of entries) {
    if (entry.id === undefined || entry.id === '' || entry.pricing === undefined) continue;
    pricingByModel.set(entry.id, {
      inputUsdPerToken: parseRate(entry.pricing.prompt),
      cachedInputUsdPerToken: parseRate(entry.pricing.input_cache_read),
      outputUsdPerToken: parseRate(entry.pricing.completion),
      reasoningUsdPerToken: parseRate(entry.pricing.internal_reasoning),
      requestUsd: parseRate(entry.pricing.request),
    });
  }
  catalogCache.set(baseUrl, { expiresAt: now + OPENROUTER_CATALOG_CACHE_TTL_MS, pricingByModel });
  return pricingByModel;
}

const unavailable = (usage: RunUsage, message: string): CostResolution => ({
  source: 'unavailable', costUsd: null, actualCostUsd: null, estimatedCostUsd: null,
  breakdown: buildTokenBreakdown(usage), pricingVersion: OPENROUTER_PRICING_VERSION, message,
});

/** A figure from the live catalogue for this model, or the counts alone, naming why there is no figure. */
export async function estimateOpenRouterCost(model: string, usage: RunUsage, options: { baseUrl?: string; apiKey?: string } = {}): Promise<CostResolution> {
  if (options.apiKey === undefined || options.apiKey === '') return unavailable(usage, 'OpenRouter API key not configured');
  const breakdown = buildTokenBreakdown(usage);
  try {
    const pricingByModel = await fetchPricingCatalog(options.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL, options.apiKey);
    const pricing = pricingByModel.get(model);
    if (pricing === undefined) return unavailable(usage, `No OpenRouter pricing metadata found for ${model}`);
    if (!hasAnyPricing(pricing)) return unavailable(usage, `OpenRouter pricing unavailable for ${model}`);
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
      breakdown: { ...breakdown, inputCostUsd, cachedInputCostUsd, outputCostUsd, reasoningCostUsd, requestCostUsd, totalCostUsd, cacheSavingsUsd },
      pricingVersion: OPENROUTER_PRICING_VERSION,
      providerMetadata: { ...pricing },
    };
  } catch (error) {
    return unavailable(usage, error instanceof Error ? error.message : 'OpenRouter pricing lookup failed');
  }
}
