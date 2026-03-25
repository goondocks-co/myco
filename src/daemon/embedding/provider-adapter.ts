/**
 * Adapter wrapping the existing EmbeddingProvider interface into the
 * ManagerEmbeddingProvider contract used by EmbeddingManager.
 *
 * Uses `generateEmbedding` (L2-normalised) rather than raw `provider.embed()`
 * so vectors are always unit-length before storage.
 */

import type { EmbeddingProvider } from '@myco/intelligence/llm.js';
import type { EmbeddingProviderConfig } from '@myco/config/schema.js';
import { generateEmbedding } from '@myco/intelligence/embeddings.js';
import { EMBEDDING_DIMENSIONS } from '@myco/db/schema.js';
import type { ManagerEmbeddingProvider } from './types.js';

export class EmbeddingProviderAdapter implements ManagerEmbeddingProvider {
  readonly model: string;
  readonly providerName: string;
  readonly dimensions: number;

  constructor(
    private provider: EmbeddingProvider,
    config: EmbeddingProviderConfig,
  ) {
    this.model = config.model;
    this.providerName = config.provider;
    this.dimensions = EMBEDDING_DIMENSIONS;
  }

  async embed(text: string): Promise<number[] | null> {
    try {
      const isUp = await this.provider.isAvailable();
      if (!isUp) return null;
      const result = await generateEmbedding(this.provider, text);
      return result.embedding;
    } catch {
      return null;
    }
  }
}
