import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIEmbeddingProvider } from '@myco/cli/providers/openai-embeddings';

describe('OpenAIEmbeddingProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MYCO_OPENAI_API_KEY;
  });

  it('constructs with explicit api key and model', () => {
    const provider = new OpenAIEmbeddingProvider({
      api_key: 'sk-test',
      model: 'text-embedding-3-small',
    });
    expect(provider.name).toBe('openai');
  });

  it('constructs without api_key, falling back to env', () => {
    process.env.MYCO_OPENAI_API_KEY = 'sk-env';
    const provider = new OpenAIEmbeddingProvider({
      model: 'text-embedding-3-small',
    });
    expect(provider.name).toBe('openai');
  });

  it('constructs with no config at all', () => {
    const provider = new OpenAIEmbeddingProvider({});
    expect(provider.name).toBe('openai');
  });

  it('listModels returns embedding models only', async () => {
    const provider = new OpenAIEmbeddingProvider({ api_key: 'sk-test' });

    const mockResponse = {
      ok: true,
      json: async () => ({
        data: [
          { id: 'text-embedding-3-small', owned_by: 'openai' },
          { id: 'text-embedding-3-large', owned_by: 'openai' },
          { id: 'gpt-4o', owned_by: 'openai' },
        ],
      }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse as Response);

    const models = await provider.listModels();
    expect(models).toEqual([
      'text-embedding-3-small',
      'text-embedding-3-large',
    ]);
  });

  it('isAvailable returns false on network error', async () => {
    const provider = new OpenAIEmbeddingProvider({ api_key: 'sk-test' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network'));

    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });
});
