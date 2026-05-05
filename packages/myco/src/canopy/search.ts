/**
 * Shared canopy search helper.
 *
 * Both the harness `vault_search_canopy` tool and the daemon `/api/search`
 * canopy branch route through this module so they assemble the same filter
 * shape, hit the `canopy_entries` namespace, and hydrate `llm_description`
 * via a single batched SQL lookup instead of N per-row queries.
 */

import type { VectorStore } from '../daemon/embedding/types.js';
import { CANOPY_ENTRIES_NAMESPACE } from '../db/queries/embeddings.js';
import { hydrateCanopyDescriptionsBatch } from './hydrate.js';

export interface CanopySearchOptions {
  query: string;
  limit: number;
  threshold: number;
  project_id?: string | null;
  language?: string;
}

export interface CanopySearchRow {
  project_id: string | null;
  path: string | null;
  llm_description: string | null;
  language: string | null;
  score: number;
}

/**
 * Embed the query, search the canopy_entries vector namespace, and hydrate
 * llm_description for all results in a single batched SQL lookup.
 *
 * Returns null when the embedding provider is unavailable; throws on other
 * errors so the caller can classify them in its own error envelope.
 */
export async function searchCanopy(
  embeddingManager: {
    embedQuery(text: string): Promise<number[] | null>;
    searchVectors: VectorStore['search'];
  },
  options: CanopySearchOptions,
): Promise<CanopySearchRow[] | null> {
  const queryVector = await embeddingManager.embedQuery(options.query);
  if (!queryVector) return null;

  const filters = {
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.project_id !== undefined && options.project_id !== null ? { project_id: options.project_id } : {}),
  };
  const raw = embeddingManager.searchVectors(queryVector, {
    namespace: CANOPY_ENTRIES_NAMESPACE,
    limit: options.limit,
    threshold: options.threshold,
    filters: Object.keys(filters).length > 0 ? filters : undefined,
  });

  const ids = raw.map((r) => r.id);
  const descriptions = hydrateCanopyDescriptionsBatch(ids);

  return raw.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      project_id: typeof meta.project_id === 'string' ? meta.project_id : null,
      path: typeof meta.path === 'string' ? meta.path : null,
      llm_description: descriptions.get(r.id) ?? null,
      language: typeof meta.language === 'string' ? meta.language : null,
      score: r.similarity,
    };
  });
}
