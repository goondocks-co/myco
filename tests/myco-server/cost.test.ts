/**
 * What a run cost, resolved on the Deployment: the harness's own figure where
 * it gave one, a priced estimate from the counts where a table or a catalogue
 * prices the model, and the counts alone in every other case — never a figure invented.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { estimateOpenRouterCost, getCostProvider, resolveCost } from '@myco-server-worker/core/cost/index.js';

afterEach(() => { vi.unstubAllGlobals(); });

const stubCatalog = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })));

describe('which resolver prices a run', () => {
  it('is chosen by the provider the model was reached through', () => {
    expect(getCostProvider({ harness: 'codex', model: 'openrouter/auto', provider: { type: 'openrouter' }, usage: {} })?.id).toBe('openrouter');
    expect(getCostProvider({ harness: 'opencode', model: 'llama3.2', provider: { type: 'ollama' }, usage: {} })?.id).toBe('generic-configured');
    expect(getCostProvider({ harness: 'claude-code', model: 'claude', provider: { type: 'anthropic' }, usage: {} })?.id).toBe('anthropic-harness');
    expect(getCostProvider({ harness: 'claude-code', model: 'claude', usage: {} })).toBeNull();
  });
});

describe('resolveCost', () => {
  it('keeps a harness estimate distinct from an actual charge, including known zero', async () => {
    for (const cost of [0, 0.25]) {
      expect(await resolveCost({ harness: 'claude-code', model: '', usage: { estimatedCostUsd: cost } }))
        .toMatchObject({ source: 'estimated', costUsd: cost, actualCostUsd: null, estimatedCostUsd: cost });
    }
  });

  it('takes the figure the harness reported over any estimate', async () => {
    const result = await resolveCost({
      harness: 'claude-code', model: 'claude-sonnet-4-6', provider: { type: 'anthropic' },
      usage: { inputTokens: 1_500, outputTokens: 350, totalTokens: 1_850, costUsd: 0.0042 },
    });
    expect(result).toMatchObject({ source: 'actual', costUsd: 0.0042, actualCostUsd: 0.0042, estimatedCostUsd: null });
    expect(result.breakdown.totalCostUsd).toBe(0.0042);
  });

  it('answers the counts alone, with the reason, where nothing prices the model', async () => {
    const result = await resolveCost({ harness: 'claude-code', model: 'claude', provider: { type: 'anthropic' }, usage: { inputTokens: 10, outputTokens: 5 } });
    expect(result).toMatchObject({ source: 'unavailable', costUsd: null, message: 'Anthropic harness did not report cost for this run' });
    expect(result.breakdown).toMatchObject({ inputTokens: 10, uncachedInputTokens: 10, outputTokens: 5, cachedInputTokens: 0 });
    expect((await resolveCost({ harness: 'x', model: 'm', usage: {} })).message).toBe('No provider cost resolver available');
  });

  it('estimates OpenAI pricing from the built-in table, with the cached-input discount', async () => {
    const result = await resolveCost({
      harness: 'codex', model: 'gpt-5.4-nano', provider: { type: 'openai' },
      usage: { inputTokens: 165_021, cachedTokens: 111_104, outputTokens: 453, totalTokens: 165_474 },
    });
    expect(result.source).toBe('estimated');
    expect(result.costUsd).toBeCloseTo(0.01357173);
    expect(result.breakdown.cachedInputTokens).toBe(111_104);
    expect(result.breakdown.uncachedInputTokens).toBe(53_917);
    expect(result.breakdown.cacheSavingsUsd).toBeCloseTo(0.01999872);
    expect((await resolveCost({ harness: 'codex', model: 'gpt-unknown', provider: { type: 'openai' }, usage: {} })).source).toBe('unavailable');
  });

  it('estimates OpenRouter pricing from the live catalogue under the Deployment\'s key', async () => {
    stubCatalog({ data: [{ id: 'openai/gpt-5.4-mini', pricing: { prompt: '0.00000075', input_cache_read: '0.000000075', completion: '0.0000045', request: '0' } }] });
    const result = await resolveCost({
      harness: 'codex', model: 'openai/gpt-5.4-mini', provider: { type: 'openrouter', apiKey: 'test-key', baseUrl: 'https://openrouter.test-live/api/v1' },
      usage: { requests: 2, inputTokens: 2_000, cachedTokens: 500, outputTokens: 300 },
    });
    expect(result.source).toBe('estimated');
    expect(result.costUsd).toBeCloseTo(0.0025125);
    expect(result.breakdown.inputCostUsd).toBeCloseTo(0.001125);
    expect(result.breakdown.cachedInputCostUsd).toBeCloseTo(0.0000375);
    expect(result.breakdown.outputCostUsd).toBeCloseTo(0.00135);
  });

  it('prices nothing from OpenRouter without a key, and reads a negative catalogue rate as no price', async () => {
    const none = await estimateOpenRouterCost('openrouter/auto', { inputTokens: 1 });
    expect(none).toMatchObject({ source: 'unavailable', message: 'OpenRouter API key not configured' });
    stubCatalog({ data: [{ id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } }] });
    const negative = await estimateOpenRouterCost('openrouter/auto', { requests: 1, inputTokens: 2_000, outputTokens: 300 }, { apiKey: 'k', baseUrl: 'https://openrouter.test-negative/api/v1' });
    expect(negative).toMatchObject({ source: 'unavailable', costUsd: null, estimatedCostUsd: null });
  });
});

/**
 * The catalogue is read from the network and cached; an answer that is not the
 * shape the catalogue promises is refused whole and leaves the cache untouched,
 * so a poisoned or oversized answer never prices a run and never sticks.
 */
describe('the OpenRouter catalogue read', () => {
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, requests: 1 };

  it('refuses data that is not an array, and fetches again rather than caching the refusal', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: null }) }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await estimateOpenRouterCost('anthropic/claude-sonnet', usage, { apiKey: 'k', baseUrl: 'https://openrouter.test-null/api/v1' });
    expect(first).toMatchObject({ source: 'unavailable' });
    expect(first.message).toMatch(/missing data array/i);
    await estimateOpenRouterCost('anthropic/claude-sonnet', usage, { apiKey: 'k', baseUrl: 'https://openrouter.test-null/api/v1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a body that is not an object', async () => {
    stubCatalog('not-an-object');
    const result = await estimateOpenRouterCost('anthropic/claude-sonnet', usage, { apiKey: 'k', baseUrl: 'https://openrouter.test-str/api/v1' });
    expect(result.message).toMatch(/missing data array/i);
  });

  it('refuses a catalogue past the entry ceiling, and fetches again rather than caching it', async () => {
    const huge = Array.from({ length: 10_001 }, (_, i) => ({ id: `model-${i}`, pricing: { prompt: '0.001', completion: '0.002' } }));
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: huge }) }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await estimateOpenRouterCost('model-0', usage, { apiKey: 'k', baseUrl: 'https://openrouter.test-huge/api/v1' });
    expect(result.message).toMatch(/exceeded/i);
    await estimateOpenRouterCost('model-0', usage, { apiKey: 'k', baseUrl: 'https://openrouter.test-huge/api/v1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches a well-formed catalogue, so a second run on the same base URL fetches nothing', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: 'valid-model', pricing: { prompt: '0.001', completion: '0.002' } }] }) }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await estimateOpenRouterCost('valid-model', usage, { apiKey: 'k', baseUrl: 'https://openrouter.test-ok/api/v1' })).source).toBe('estimated');
    expect((await estimateOpenRouterCost('valid-model', usage, { apiKey: 'k', baseUrl: 'https://openrouter.test-ok/api/v1' })).source).toBe('estimated');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
