import type { OutboundFetch, RelationalStore, SecretWrappingKey } from '../adapters.js';
import type { DeploymentTarget } from '@goondocks/myco-shared/settings-contract';
import { EMBEDDING_CATALOGUE } from '@goondocks/myco-shared/settings-contract';
import { storedEmbedding } from '../settings.js';
import { openProviderCredential, providerCredentialReady } from '../provider-credentials.js';
import { embeddingText, embeddingValues, EmbeddingUnavailable, EMBEDDING_TIMEOUT_MS, type EmbeddingProvider } from './provider.js';
import { resolveEmbedding, type EmbeddingResolution, type EmbeddingSelection, type StoredEmbedding } from './policy.js';

/** What the platform contributes to embedding: its target, and the provider its own binding serves a model through, where it has one. */
export interface EmbeddingPlatform {
  target: DeploymentTarget;
  bindingProvider?: (selection: EmbeddingSelection) => EmbeddingProvider;
}

/** The provider an embedding choice resolves to, or why it cannot compute vectors on this Deployment now. */
export type EmbeddingProviderAnswer = { provider: EmbeddingProvider; reason: null } | { provider: null; reason: string };

/** What an embedding choice resolves to on this Deployment, judged against the credentials and binding it has. */
async function resolutionOf(db: RelationalStore, wrappingKey: SecretWrappingKey, platform: EmbeddingPlatform, stored: StoredEmbedding): Promise<EmbeddingResolution> {
  const slot = resolveEmbedding(stored, platform.target).selection?.credential ?? null;
  const ready = slot !== null && await providerCredentialReady(db, wrappingKey, slot);
  return resolveEmbedding(stored, platform.target, {
    workersAi: platform.bindingProvider !== undefined,
    credentials: new Set(ready ? [slot] : []),
  });
}

/** The embedding selection this Deployment searches with, and what each embedding leaf resolves to: the one policy search and Settings share. */
export async function embeddingResolution(db: RelationalStore, wrappingKey: SecretWrappingKey, platform: EmbeddingPlatform): Promise<EmbeddingResolution> {
  return resolutionOf(db, wrappingKey, platform, await storedEmbedding(db));
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

/** The provider an embedding choice resolves to on this Deployment, or why there is none. */
export async function embeddingProviderFor(
  db: RelationalStore, wrappingKey: SecretWrappingKey, outbound: OutboundFetch, platform: EmbeddingPlatform, stored: StoredEmbedding,
): Promise<EmbeddingProviderAnswer> {
  const { selection, reason } = await resolutionOf(db, wrappingKey, platform, stored);
  if (selection === null) return { provider: null, reason: reason ?? 'No embedding provider is chosen.' };
  if (selection.url === null) {
    const bound = platform.bindingProvider?.(selection);
    return bound === undefined ? { provider: null, reason: 'Workers AI is not set up on this server.' } : { provider: bound, reason: null };
  }
  const credential = selection.credential === null ? null : await openProviderCredential(db, wrappingKey, selection.credential);
  if (selection.credential !== null && credential === null) {
    return { provider: null, reason: `No ${EMBEDDING_CATALOGUE[selection.provider].label} key is stored. Add one under Provider keys.` };
  }
  return { provider: httpEmbeddingProvider({ ...selection, url: selection.url }, credential, outbound), reason: null };
}

/** The provider the embedding policy selects on this Deployment, or null when semantic search is off. */
export async function configuredEmbeddingProvider(db: RelationalStore, wrappingKey: SecretWrappingKey, outbound: OutboundFetch, platform: EmbeddingPlatform): Promise<EmbeddingProvider | null> {
  return (await embeddingProviderFor(db, wrappingKey, outbound, platform, await storedEmbedding(db))).provider;
}
