/**
 * Search API handler — supports FTS, semantic, and auto modes.
 *
 * - mode=fts: FTS5 full-text search (prompt_batches + activities)
 * - mode=semantic: Vector similarity search via VectorStore (sessions, spores, plans, artifacts)
 * - mode=auto (default): Tries semantic first, falls back to FTS if provider unavailable
 */

import { fullTextSearch, hydrateSearchResults } from '@myco/db/queries/search.js';
import {
  SEARCH_RESULTS_DEFAULT_LIMIT,
  SEARCH_SIMILARITY_THRESHOLD,
  TEAM_SOURCE_PREFIX,
} from '@myco/constants.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { TeamSyncClient, TeamSearchResult } from '../team-sync.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid search modes. */
type SearchMode = 'auto' | 'semantic' | 'fts';

/** Dependencies injected by the daemon when registering the route. */
export interface SearchDeps {
  embeddingManager: EmbeddingManager;
  getTeamClient?: () => TeamSyncClient | null;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create a search handler with injected dependencies.
 *
 * Returns an async handler that supports `mode` query parameter:
 * - `auto` (default): tries semantic search, falls back to FTS
 * - `semantic`: vector similarity search only
 * - `fts`: FTS5 text search only
 */
export function createSearchHandler(deps: SearchDeps) {
  return async function handleSearch(req: RouteRequest): Promise<RouteResponse> {
    const query = req.query.q;
    if (!query) return { status: 400, body: { error: 'missing_query' } };

    const mode = (req.query.mode ?? 'auto') as SearchMode;
    const type = req.query.type;
    const limit = Number(req.query.limit) || SEARCH_RESULTS_DEFAULT_LIMIT;
    const namespace = req.query.namespace;

    // --- FTS-only mode ---
    if (mode === 'fts') {
      const results = fullTextSearch(query, { type, limit });
      return { body: { mode: 'fts', results } };
    }

    // --- Semantic or auto mode: attempt vector search ---
    const queryVector = await deps.embeddingManager.embedQuery(query);

    // If provider unavailable, auto falls back to FTS; semantic returns empty
    if (queryVector === null) {
      if (mode === 'auto') {
        const results = fullTextSearch(query, { type, limit });
        return { body: { mode: 'fts', results, fallback: true } };
      }
      // mode === 'semantic' but no provider
      return { body: { mode: 'semantic', results: [], provider_unavailable: true } };
    }

    // Vector search with optional namespace/type filtering
    const searchNamespace = namespace ?? type;
    const vectorResults = deps.embeddingManager.searchVectors(queryVector, {
      namespace: searchNamespace,
      limit,
      threshold: SEARCH_SIMILARITY_THRESHOLD,
    });

    // Hydrate local vector results into full SearchResults
    const localResults = hydrateSearchResults(vectorResults).map((r) => ({
      ...r,
      source: 'local',
    }));

    // Fan out to team search in parallel (if connected)
    const teamClient = deps.getTeamClient?.();
    let teamResults: Array<TeamSearchResult & { source: string }> = [];
    if (teamClient) {
      try {
        const teamResponse = await teamClient.search(query, { limit });
        teamResults = teamResponse.results.map((r) => ({
          ...r,
          source: `${TEAM_SOURCE_PREFIX}${r.machine_id}`,
        }));
      } catch {
        // Team search failure is non-blocking — local results still returned
      }
    }

    // Merge by score (highest first), slice to limit
    const merged = [...localResults, ...teamResults]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);

    return { body: { mode: 'semantic', results: merged } };
  };
}
