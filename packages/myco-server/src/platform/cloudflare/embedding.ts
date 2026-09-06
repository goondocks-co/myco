import { embeddingText, embeddingValues, EmbeddingUnavailable, EMBEDDING_TIMEOUT_MS, type EmbeddingProvider } from '../../core/embedding/provider.js';

export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export interface EmbeddingBinding {
  run(model: typeof EMBEDDING_MODEL, input: { text: string[] }, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export function cloudflareEmbeddingProvider(ai: EmbeddingBinding): EmbeddingProvider {
  return {
    modelKey: JSON.stringify(['cloudflare', EMBEDDING_MODEL]),
    async embed(text) {
      let result: unknown;
      try { result = await ai.run(EMBEDDING_MODEL, { text: [embeddingText(text)] }, { signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS) }); }
      catch { throw new EmbeddingUnavailable('embedding provider could not be reached'); }
      return embeddingValues((result as { data?: unknown[] })?.data?.[0]);
    },
  };
}
