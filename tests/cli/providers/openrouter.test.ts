import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenRouterEmbeddingProvider } from '@myco/cli/providers/openrouter';

describe('OpenRouterEmbeddingProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MYCO_OPENROUTER_API_KEY;
  });

  it('constructs with explicit api key and model', () => {
    const provider = new OpenRouterEmbeddingProvider({
      api_key: 'sk-or-test',
      model: 'openai/text-embedding-3-small',
    });
    expect(provider.name).toBe('openrouter');
  });

  it('constructs without api_key, falling back to env', () => {
    process.env.MYCO_OPENROUTER_API_KEY = 'sk-or-env';
    const provider = new OpenRouterEmbeddingProvider({
      model: 'openai/text-embedding-3-small',
    });
    expect(provider.name).toBe('openrouter');
  });

  it('constructs with no config at all', () => {
    const provider = new OpenRouterEmbeddingProvider({});
    expect(provider.name).toBe('openrouter');
  });

  it('listModels returns array of model IDs', async () => {
    const provider = new OpenRouterEmbeddingProvider({ api_key: 'sk-or-test' });

    const mockResponse = {
      ok: true,
      json: async () => ({
        data: [
          { id: 'openai/text-embedding-3-small', context_length: 8191 },
          { id: 'openai/text-embedding-3-large', context_length: 8191 },
        ],
      }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse as Response);

    const models = await provider.listModels();
    expect(models).toEqual([
      'openai/text-embedding-3-small',
      'openai/text-embedding-3-large',
    ]);
  });

  it('isAvailable returns false on network error', async () => {
    const provider = new OpenRouterEmbeddingProvider({ api_key: 'sk-or-test' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network'));

    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });
});
