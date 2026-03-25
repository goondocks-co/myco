import { fullTextSearch } from '@myco/db/queries/search.js';
import { SEARCH_RESULTS_DEFAULT_LIMIT } from '@myco/constants.js';
import type { RouteRequest, RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleSearch(req: RouteRequest): Promise<RouteResponse> {
  const query = req.query.q;
  if (!query) return { status: 400, body: { error: 'missing_query' } };

  const mode = req.query.mode ?? 'fts';
  const type = req.query.type;
  const limit = Number(req.query.limit) || SEARCH_RESULTS_DEFAULT_LIMIT;

  // FTS search — semantic search via external vector store is deferred
  const results = fullTextSearch(query, { type, limit });
  return { body: { mode: 'fts', results } };
}
