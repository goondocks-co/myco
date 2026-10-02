import { embeddingText, embeddingValues, EmbeddingUnavailable, EMBEDDING_TIMEOUT_MS, type EmbeddingProvider } from '../../core/embedding/provider.js';
import type { EmbeddingSelection } from '../../core/embedding/policy.js';
import { EMBEDDING_CATALOGUE } from '@goondocks/myco-shared/settings-contract';

/** The Workers AI model a Deployment embeds with until an admin chooses another. */
export const EMBEDDING_MODEL = EMBEDDING_CATALOGUE['workers-ai'].defaultModel;

export interface EmbeddingBinding {
  run(model: string, input: { text: string[] }, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** The Workers AI binding computing vectors with the selected model, partitioned under the selection's identity. */
export function cloudflareEmbeddingProvider(ai: EmbeddingBinding, selection: Pick<EmbeddingSelection, 'model' | 'modelKey'>): EmbeddingProvider {
  return {
    modelKey: selection.modelKey,
    async embed(text) {
      let result: unknown;
      try { result = await ai.run(selection.model, { text: [embeddingText(text)] }, { signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS) }); }
      catch { throw new EmbeddingUnavailable('embedding provider could not be reached'); }
      return embeddingValues((result as { data?: unknown[] })?.data?.[0]);
    },
  };
}
