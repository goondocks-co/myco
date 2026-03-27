import { describe, it, expect } from 'vitest';
import type { EmbeddingProvider } from '@myco/intelligence/llm';
import type { EmbeddingProviderConfig } from '@myco/config/schema';
import { EMBEDDING_DIMENSIONS } from '@myco/db/schema';
import { EmbeddingProviderAdapter } from '@myco/daemon/embedding/provider-adapter';

const MOCK_EMBEDDING_DIM = 4;

const mockProvider: EmbeddingProvider = {
  name: 'mock',
  async embed(text: string) {
    const embedding = Array.from({ length: MOCK_EMBEDDING_DIM }, (_, i) => text.length * 0.01 + i * 0.1);
    return { embedding, model: 'mock-embed', dimensions: MOCK_EMBEDDING_DIM };
  },
  async isAvailable() { return true; },
};

const mockConfig: EmbeddingProviderConfig = {
  provider: 'ollama',
  model: 'bge-m3',
};

describe('EmbeddingProviderAdapter', () => {
  it('returns a normalized vector when provider is available', async () => {
    const adapter = new EmbeddingProviderAdapter(mockProvider, mockConfig);
    const result = await adapter.embed('hello world');

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);

    // Verify normalization: magnitude should be ~1.0
    const magnitude = Math.sqrt(result!.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  it('returns a vector with the expected length', async () => {
    const adapter = new EmbeddingProviderAdapter(mockProvider, mockConfig);
    const result = await adapter.embed('test input');

    expect(result).not.toBeNull();
    expect(result).toHaveLength(MOCK_EMBEDDING_DIM);
  });

  it('returns null when provider isAvailable() returns false', async () => {
    const unavailableProvider: EmbeddingProvider = {
      name: 'unavailable',
      async embed() {
        throw new Error('should not be called');
      },
      async isAvailable() { return false; },
    };

    const adapter = new EmbeddingProviderAdapter(unavailableProvider, mockConfig);
    const result = await adapter.embed('test');

    expect(result).toBeNull();
  });

  it('returns null when provider embed() throws an error', async () => {
    const failingProvider: EmbeddingProvider = {
      name: 'failing',
      async embed() {
        throw new Error('embedding service crashed');
      },
      async isAvailable() { return true; },
    };

    const adapter = new EmbeddingProviderAdapter(failingProvider, mockConfig);
    const result = await adapter.embed('test');

    expect(result).toBeNull();
  });

  it('returns null when isAvailable() throws', async () => {
    const throwingProvider: EmbeddingProvider = {
      name: 'throwing',
      async embed() {
        throw new Error('should not be called');
      },
      async isAvailable() {
        throw new Error('network unreachable');
      },
    };

    const adapter = new EmbeddingProviderAdapter(throwingProvider, mockConfig);
    const result = await adapter.embed('test');

    expect(result).toBeNull();
  });

  it('exposes model, providerName, and dimensions from config', () => {
    const config: EmbeddingProviderConfig = {
      provider: 'openai-compatible',
      model: 'text-embedding-3-small',
    };

    const adapter = new EmbeddingProviderAdapter(mockProvider, config);

    // Non-Ollama providers: model string passed through unchanged
    expect(adapter.model).toBe('text-embedding-3-small');
    expect(adapter.providerName).toBe('openai-compatible');
    expect(adapter.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });

  // -------------------------------------------------------------------------
  // Model string normalization
  // -------------------------------------------------------------------------

  describe('model name normalization', () => {
    it('appends :latest to untagged Ollama model names', () => {
      const adapter = new EmbeddingProviderAdapter(mockProvider, {
        provider: 'ollama',
        model: 'bge-m3',
      });
      expect(adapter.model).toBe('bge-m3:latest');
    });

    it('preserves explicit :latest tag on Ollama models', () => {
      const adapter = new EmbeddingProviderAdapter(mockProvider, {
        provider: 'ollama',
        model: 'bge-m3:latest',
      });
      expect(adapter.model).toBe('bge-m3:latest');
    });

    it('preserves non-latest tags on Ollama models', () => {
      const adapter = new EmbeddingProviderAdapter(mockProvider, {
        provider: 'ollama',
        model: 'nomic-embed-text:v1.5',
      });
      expect(adapter.model).toBe('nomic-embed-text:v1.5');
    });

    it('does NOT modify model names for non-Ollama providers', () => {
      const adapter = new EmbeddingProviderAdapter(mockProvider, {
        provider: 'openai',
        model: 'text-embedding-3-small',
      });
      expect(adapter.model).toBe('text-embedding-3-small');
    });

    it('does NOT modify model names for openrouter provider', () => {
      const adapter = new EmbeddingProviderAdapter(mockProvider, {
        provider: 'openrouter',
        model: 'openai/text-embedding-3-small',
      });
      expect(adapter.model).toBe('openai/text-embedding-3-small');
    });
  });
});
