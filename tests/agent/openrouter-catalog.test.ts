/**
 * Runtime validation for the OpenRouter pricing-catalog fetch.
 *
 * The original implementation trusted a raw JSON type assertion — a poisoned
 * response could corrupt the in-memory cache or blow memory. These tests
 * pin down the new guards: non-object response, non-array `data`, and a
 * hard entry-count cap. On rejection the cache MUST NOT be populated.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { estimateOpenRouterCost } from '@myco/agent/cost/openrouter';
import { OPENROUTER_API_KEY_ENV } from '@myco/cli/providers/openrouter.js';

const fetchMock = vi.fn();
global.fetch = fetchMock as unknown as typeof fetch;

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
});

const sampleUsage = {
  inputTokens: 10, outputTokens: 5, totalTokens: 15, requests: 1,
};

describe('OpenRouter catalog validation', () => {
  it('rejects a response with data=null (does not poison the cache)', async () => {
    vi.stubEnv(OPENROUTER_API_KEY_ENV, 'sk-or-test');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: null }) });

    const result = await estimateOpenRouterCost('anthropic/claude-sonnet', sampleUsage, 'https://openrouter.test-null/api/v1');
    expect(result.source).toBe('unavailable');
    expect(result.message).toMatch(/missing data array/i);

    // Second call should re-fetch (cache NOT populated by the rejected response)
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: null }) });
    await estimateOpenRouterCost('anthropic/claude-sonnet', sampleUsage, 'https://openrouter.test-null/api/v1');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('rejects a response that is not an object', async () => {
    vi.stubEnv(OPENROUTER_API_KEY_ENV, 'sk-or-test');
    fetchMock.mockResolvedValue({ ok: true, json: async () => 'not-an-object' });

    const result = await estimateOpenRouterCost('anthropic/claude-sonnet', sampleUsage, 'https://openrouter.test-str/api/v1');
    expect(result.source).toBe('unavailable');
    expect(result.message).toMatch(/missing data array/i);
  });

  it('rejects a response with more than 10_000 entries', async () => {
    vi.stubEnv(OPENROUTER_API_KEY_ENV, 'sk-or-test');
    const huge = Array.from({ length: 10_001 }, (_, i) => ({
      id: `model-${i}`,
      pricing: { prompt: '0.001', completion: '0.002' },
    }));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: huge }) });

    const result = await estimateOpenRouterCost('model-0', sampleUsage, 'https://openrouter.test-huge/api/v1');
    expect(result.source).toBe('unavailable');
    expect(result.message).toMatch(/exceeded/i);

    // Cache must not be populated
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: huge }) });
    await estimateOpenRouterCost('model-0', sampleUsage, 'https://openrouter.test-huge/api/v1');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('accepts a valid response with a small data array', async () => {
    vi.stubEnv(OPENROUTER_API_KEY_ENV, 'sk-or-test');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'valid-model', pricing: { prompt: '0.001', completion: '0.002' } }],
      }),
    });

    const result = await estimateOpenRouterCost('valid-model', sampleUsage, 'https://openrouter.test-ok/api/v1');
    expect(result.source).toBe('estimated');
  });
});
