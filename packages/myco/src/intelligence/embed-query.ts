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
 * Try embedding the query text. Returns null ONLY for the "no provider
 * configured" and "provider reports not available" cases, which are the
 * legitimate graceful-no-op paths. Any other error (timeout, network,
 * dimension mismatch, provider crash) is rethrown so callers can surface
 * the actual cause instead of seeing an undifferentiated null.
 *
 * The embedding provider is cached after first creation — subsequent calls
 * skip config loading and provider construction.
 */
export async function tryEmbed(text: string): Promise<number[] | null> {
  if (!cachedProvider) {
    // Dynamic import to avoid hard dependency on config at load time.
    // In Phase 1, embedding providers may not be configured.
    const { createEmbeddingProvider } = await import('./llm.js');
    const { loadMergedConfig } = await import('@myco/config/loader.js');
    const { resolveVaultDir } = await import('@myco/vault/resolve.js');

    const vaultDir = resolveVaultDir();
    const config = loadMergedConfig(vaultDir);
    if (!config.embedding) return null;

    try {
      cachedProvider = createEmbeddingProvider(config.embedding);
    } catch (err) {
      // Provider construction failure is a real config problem, not a
      // "gracefully no embeddings configured" case. Re-throw so the
      // caller sees the actual message (invalid base_url, missing model, etc.).
      throw new Error(
        `Failed to construct embedding provider from config: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  const isUp = await cachedProvider.isAvailable();
  if (!isUp) return null;

  const { generateEmbedding } = await import('./embeddings.js');
  const result = await generateEmbedding(cachedProvider, text);
  return result.embedding;
}
