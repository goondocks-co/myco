/**
 * Shared embedding helper — embeds a text query using the configured provider.
 *
 * Caches the embedding provider after first creation to avoid re-instantiating
 * on every call. Returns null gracefully when no provider is configured or
 * the provider is unavailable.
 */

import type { EmbeddingProvider } from './llm.js';

// ---------------------------------------------------------------------------
// Cached provider singleton
// ---------------------------------------------------------------------------

let cachedProvider: EmbeddingProvider | null = null;

/**
 * Try embedding the query text. Returns null if no provider is available.
 *
 * The embedding provider is cached after first creation — subsequent calls
 * skip config loading and provider construction.
 */
export async function tryEmbed(text: string): Promise<number[] | null> {
  try {
    if (!cachedProvider) {
      // Dynamic import to avoid hard dependency on config at load time.
      // In Phase 1, embedding providers may not be configured.
      const { createEmbeddingProvider } = await import('./llm.js');
      const { loadConfig } = await import('@myco/config/loader.js');
      const { resolveVaultDir } = await import('@myco/vault/resolve.js');

      const vaultDir = resolveVaultDir();
      const config = loadConfig(vaultDir);
      if (!config.intelligence?.embedding) return null;

      cachedProvider = createEmbeddingProvider(config.intelligence.embedding);
    }

    const isUp = await cachedProvider.isAvailable();
    if (!isUp) return null;

    const { generateEmbedding } = await import('./embeddings.js');
    const result = await generateEmbedding(cachedProvider, text);
    return result.embedding;
  } catch {
    return null;
  }
}
