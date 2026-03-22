import { semanticSearch, fullTextSearch } from '@myco/db/queries/search.js';
import { tryEmbed } from '../../intelligence/embed-query.js';
import { SEARCH_RESULTS_DEFAULT_LIMIT } from '@myco/constants.js';
import type { RouteRequest, RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleSearch(req: RouteRequest): Promise<RouteResponse> {
  const query = req.query.q;
  if (!query) return { status: 400, body: { error: 'missing_query' } };

  const mode = req.query.mode ?? 'semantic';
  const type = req.query.type;
  const limit = Number(req.query.limit) || SEARCH_RESULTS_DEFAULT_LIMIT;

  if (mode === 'fts') {
    const results = await fullTextSearch(query, { type, limit });
    return { body: { mode: 'fts', results } };
  }

  // Semantic search — embed query first
  const embedding = await tryEmbed(query);
  if (!embedding) {
    return { body: { mode: 'semantic', results: [], error: 'embedding_unavailable' } };
  }
  const results = await semanticSearch(embedding, { type, limit });
  return { body: { mode: 'semantic', results } };
}
