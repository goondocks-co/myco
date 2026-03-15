import { describe, it, expect, vi } from 'vitest';
import { generateEmbedding } from '@myco/intelligence/embeddings';
import type { EmbeddingProvider } from '@myco/intelligence/llm';

describe('Embeddings', () => {
  const mockBackend: EmbeddingProvider = {
    name: 'mock',
    async embed(text: string) {
      const dim = 4;
      const embedding = Array.from({ length: dim }, (_, i) => text.length * 0.01 + i * 0.1);
      return { embedding, model: 'mock-embed', dimensions: dim };
    },
    async isAvailable() { return true; },
  };

  it('generates embedding from text', async () => {
    const result = await generateEmbedding(mockBackend, 'hello world');
    expect(result.embedding).toHaveLength(4);
    expect(result.dimensions).toBe(4);
  });

  it('normalizes embeddings to unit length', async () => {
    const result = await generateEmbedding(mockBackend, 'test');
    const magnitude = Math.sqrt(result.embedding.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 5);
  });
});
