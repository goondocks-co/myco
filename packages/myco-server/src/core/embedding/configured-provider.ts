import type { OutboundFetch, RelationalStore, SecretWrappingKey } from '../adapters.js';
import type { DeploymentTarget } from '@goondocks/myco-shared/settings-contract';
import { EMBEDDING_CATALOGUE } from '@goondocks/myco-shared/settings-contract';
import { storedEmbedding } from '../settings.js';
import { openProviderCredential, providerCredentialReady } from '../provider-credentials.js';
import { embeddingText, embeddingValues, EmbeddingUnavailable, EMBEDDING_TIMEOUT_MS, type EmbeddingProvider } from './provider.js';
import { resolveEmbedding, type EmbeddingResolution, type EmbeddingSelection } from './policy.js';

/** What the platform contributes to embedding: its target, and the provider its own binding serves a model through, where it has one. */
export interface EmbeddingPlatform {
  target: DeploymentTarget;
  bindingProvider?: (selection: EmbeddingSelection) => EmbeddingProvider;
}

/** The embedding selection this Deployment searches with, and what each embedding leaf resolves to: the one policy search and Settings share. */
export async function embeddingResolution(db: RelationalStore, wrappingKey: SecretWrappingKey, platform: EmbeddingPlatform): Promise<EmbeddingResolution> {
  const stored = await storedEmbedding(db);
  const slot = resolveEmbedding(stored, platform.target).selection?.credential ?? null;
  const ready = slot !== null && await providerCredentialReady(db, wrappingKey, slot);
  return resolveEmbedding(stored, platform.target, {
    workersAi: platform.bindingProvider !== undefined,
    credentials: new Set(ready ? [slot] : []),
  });
}

/** A provider reached over HTTP. A credential travels only to its provider's own fixed endpoint. */
function httpEmbeddingProvider(selection: EmbeddingSelection & { url: string }, credential: string | null, outbound: OutboundFetch): EmbeddingProvider {
  const ollama = EMBEDDING_CATALOGUE[selection.provider].api === 'ollama';
  return {
    modelKey: selection.modelKey,
    async embed(text) {
      const signal = AbortSignal.timeout(EMBEDDING_TIMEOUT_MS);
      let response: Response;
      try {
        response = await outbound(selection.url, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', ...(credential === null ? {} : { authorization: `Bearer ${credential}` }) },
          body: JSON.stringify({ model: selection.model, input: [embeddingText(text)] }),
        });
      } catch { throw new EmbeddingUnavailable('embedding provider could not be reached'); }
      if (!response.ok) throw new EmbeddingUnavailable(`embedding provider returned HTTP ${response.status}`);
      let body: { embeddings?: unknown[]; data?: Array<{ embedding?: unknown }> };
      try { body = await response.json(); }
      catch (error) { if (signal.aborted) throw new EmbeddingUnavailable('embedding provider timed out'); throw error; }
      return embeddingValues(ollama ? body.embeddings?.[0] : body.data?.[0]?.embedding);
    },
  };
}

/** The provider the embedding policy selects on this Deployment, or null when semantic search is off. */
export async function configuredEmbeddingProvider(db: RelationalStore, wrappingKey: SecretWrappingKey, outbound: OutboundFetch, platform: EmbeddingPlatform): Promise<EmbeddingProvider | null> {
  const { selection } = await embeddingResolution(db, wrappingKey, platform);
  if (selection === null) return null;
  if (selection.url === null) return platform.bindingProvider?.(selection) ?? null;
  const credential = selection.credential === null ? null : await openProviderCredential(db, wrappingKey, selection.credential);
  if (selection.credential !== null && credential === null) return null;
  return httpEmbeddingProvider({ ...selection, url: selection.url }, credential, outbound);
}
