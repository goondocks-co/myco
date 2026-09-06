import type { RelationalStore, SecretWrappingKey } from '../adapters.js';
import { leafValues } from '../settings.js';
import { openProviderCredential } from '../provider-credentials.js';
import { embeddingText, embeddingValues, EmbeddingUnavailable, EMBEDDING_TIMEOUT_MS, type EmbeddingProvider } from './provider.js';

/** Custom endpoints receive no credential from a fixed provider's secret slot. */
export async function configuredEmbeddingProvider(db: RelationalStore, wrappingKey: SecretWrappingKey, outbound: typeof fetch): Promise<EmbeddingProvider | null> {
  const leaves = await leafValues(db, ['embedding.provider', 'embedding.model', 'embedding.base_url']);
  const read = (name: string): string | undefined => {
    const raw = leaves.get(`embedding.${name}`);
    if (raw === undefined) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`embedding.${name} must be a nonempty string`);
    return value;
  };
  const provider = read('provider');
  if (provider === undefined) return null;
  if (!['ollama', 'openai-compatible', 'openai', 'openrouter'].includes(provider)) throw new Error('unsupported embedding provider');
  const custom = read('base_url');
  const model = read('model') ?? (provider === 'openai' ? 'text-embedding-3-small' : provider === 'openrouter' ? 'baai/bge-m3' : 'bge-m3');
  const base = custom ?? ({ ollama: 'http://localhost:11434', openai: 'https://api.openai.com/v1', openrouter: 'https://openrouter.ai/api/v1' } as Record<string, string>)[provider];
  if (base === undefined) return null;
  const url = new URL(base.replace(/\/+$/, '') + (provider === 'ollama' ? '/api/embed' : '/embeddings'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') throw new Error('embedding.base_url must be an HTTP URL without credentials');
  const credential = custom === undefined && (provider === 'openai' || provider === 'openrouter')
    ? await openProviderCredential(db, wrappingKey, provider) : null;
  if (custom === undefined && (provider === 'openai' || provider === 'openrouter') && credential === null) return null;
  return {
    modelKey: JSON.stringify([provider, model, url.href]),
    async embed(text) {
      const signal = AbortSignal.timeout(EMBEDDING_TIMEOUT_MS);
      let response: Response;
      try {
        response = await outbound(url.href, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', ...(credential === null ? {} : { authorization: `Bearer ${credential}` }) },
          body: JSON.stringify({ model, input: [embeddingText(text)] }),
        });
      } catch { throw new EmbeddingUnavailable('embedding provider could not be reached'); }
      if (!response.ok) throw new EmbeddingUnavailable(`embedding provider returned HTTP ${response.status}`);
      let body: { embeddings?: unknown[]; data?: Array<{ embedding?: unknown }> };
      try { body = await response.json(); }
      catch (error) { if (signal.aborted) throw new EmbeddingUnavailable('embedding provider timed out'); throw error; }
      return embeddingValues(provider === 'ollama' ? body.embeddings?.[0] : body.data?.[0]?.embedding);
    },
  };
}
