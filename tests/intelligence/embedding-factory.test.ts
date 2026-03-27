import { describe, it, expect } from 'vitest';
import { createEmbeddingProvider } from '@myco/intelligence/llm.js';

describe('createEmbeddingProvider', () => {
  it('creates ollama embedding provider', () => {
    const provider = createEmbeddingProvider({
      provider: 'ollama',
      model: 'nomic-embed-text',
      base_url: 'http://localhost:11434',
    });
    expect(provider.name).toBe('ollama');
  });

  it('creates lm-studio embedding provider', () => {
    const provider = createEmbeddingProvider({
      provider: 'lm-studio',
      model: 'text-embedding-nomic-embed-text-v1.5',
      base_url: 'http://localhost:1234',
    });
    expect(provider.name).toBe('lm-studio');
  });

  it('creates openai-compatible embedding provider', () => {
    const provider = createEmbeddingProvider({
      provider: 'openai-compatible',
      model: 'text-embedding-nomic-embed-text-v1.5',
      base_url: 'http://localhost:1234',
    });
    expect(provider.name).toBe('lm-studio');
  });

  it('creates openrouter embedding provider', () => {
    const provider = createEmbeddingProvider({
      provider: 'openrouter',
      model: 'openai/text-embedding-3-small',
    });
    expect(provider.name).toBe('openrouter');
  });

  it('creates openai embedding provider', () => {
    const provider = createEmbeddingProvider({
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
    expect(provider.name).toBe('openai');
  });

  it('throws for unknown provider', () => {
    expect(() =>
      createEmbeddingProvider({ provider: 'unknown', model: 'some-model' })
    ).toThrow('Provider "unknown" does not support embeddings.');
  });
});
