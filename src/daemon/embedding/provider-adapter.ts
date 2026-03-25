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

/** TTL for cached availability check (ms). Avoids HTTP probe on every embed(). */
const AVAILABILITY_CACHE_TTL_MS = 5_000;

export class EmbeddingProviderAdapter implements ManagerEmbeddingProvider {
  readonly model: string;
  readonly providerName: string;
  readonly dimensions: number;

  /** Cached availability state to avoid per-embed HTTP probes. */
  private cachedAvailable: boolean | null = null;
  private cachedAvailableAt = 0;

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
      const isUp = await this.checkAvailability();
      if (!isUp) return null;
      const result = await generateEmbedding(this.provider, text);
      return result.embedding;
    } catch {
      // Provider went down mid-embed — invalidate cache
      this.cachedAvailable = null;
      return null;
    }
  }

  /** Check availability with a short TTL cache to avoid HTTP probes on every call. */
  private async checkAvailability(): Promise<boolean> {
    const now = Date.now();
    if (this.cachedAvailable !== null && (now - this.cachedAvailableAt) < AVAILABILITY_CACHE_TTL_MS) {
      return this.cachedAvailable;
    }
    this.cachedAvailable = await this.provider.isAvailable();
    this.cachedAvailableAt = now;
    return this.cachedAvailable;
  }
}
