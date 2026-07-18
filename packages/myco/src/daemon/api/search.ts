/**
 * Search API handler — supports FTS, semantic, and auto modes.
 *
 * - mode=fts: FTS5 full-text search (prompt_batches + activities)
 * - mode=semantic: Vector similarity search via VectorStore (sessions, spores, plans, artifacts)
 * - mode=auto (default): Tries semantic first, falls back to FTS if provider unavailable
 */

import { fullTextSearch, hydrateSearchResults, sanitizeFtsQuery } from '@myco/db/queries/search.js';
import { openDatabase, type Database } from '@myco/db/client.js';
import { errorMessage } from '@myco/utils/error-message.js';
import {
  SEARCH_RESULTS_DEFAULT_LIMIT,
  SEARCH_SIMILARITY_THRESHOLD,
} from '@myco/constants.js';
import { hasSemanticSearchFilters, matchesSemanticSearchFilters } from '@myco/semantic-search-filters.js';
import { normalizeSearchResults } from '@myco/search-results.js';
import { searchCanopy } from '@myco/canopy/search.js';
import { projectScopeFromRequestContext, rowProjectIdFromRequestContext, type MycoRequestContext } from '@myco/grove/request-context.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid search modes. */
type SearchMode = 'auto' | 'semantic' | 'fts';

type SearchEmbeddingManager = Pick<EmbeddingManager, 'embedQuery' | 'searchVectors'>;

const SEARCH_NAMESPACE_RULES: Array<{ key: string; value?: string }> = [
  { key: 'all', value: undefined },
  { key: 'session', value: 'sessions' },
  { key: 'sessions', value: 'sessions' },
  { key: 'spore', value: 'spores' },
  { key: 'spores', value: 'spores' },
  { key: 'plan', value: 'plans' },
  { key: 'plans', value: 'plans' },
  { key: 'artifact', value: 'artifacts' },
  { key: 'artifacts', value: 'artifacts' },
  { key: 'skill', value: 'skill_records' },
  { key: 'skill_records', value: 'skill_records' },
];

export function normalizeSearchNamespace(value?: string): string | undefined {
  if (!value) return undefined;
  for (const rule of SEARCH_NAMESPACE_RULES) {
    if (rule.key === value) return rule.value;
  }
  return value;
}

/**
 * Dependencies injected by the daemon when registering the route.
 */
export interface SearchDeps {
  embeddingManager: SearchEmbeddingManager;
  resolveEmbeddingManager?: (requestContext?: MycoRequestContext) => SearchEmbeddingManager;
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
    const requestDb = openRequestDatabase(req.requestContext);
    try {
      return await handleSearchWithDatabase(req, deps, requestDb);
    } finally {
      requestDb?.close();
    }
  };
}

async function handleSearchWithDatabase(
  req: RouteRequest,
  deps: SearchDeps,
  db?: Database,
): Promise<RouteResponse> {
    const query = req.query.q;
    if (!query) return { status: 400, body: { error: 'missing_query' } };

    const mode = (req.query.mode ?? 'auto') as SearchMode;
    const type = req.query.type;
    const limit = Number(req.query.limit) || SEARCH_RESULTS_DEFAULT_LIMIT;
    const namespace = req.query.namespace;
    const projectId = rowProjectIdFromRequestContext(req.requestContext);
    const scope = projectScopeFromRequestContext(req.requestContext);
    const metadataFilters = {
      ...(req.query.status ? { status: req.query.status } : {}),
      ...(req.query.session_id ? { session_id: req.query.session_id } : {}),
      ...(req.query.observation_type ? { observation_type: req.query.observation_type } : {}),
      ...(typeof projectId === 'string' ? { project_id: projectId } : {}),
      ...(req.query.release_state ? { release_state: req.query.release_state } : {}),
      ...(req.query.release_confidence ? { release_confidence: req.query.release_confidence } : {}),
      ...(req.query.since ? { created_at_gte: Number(req.query.since) } : {}),
      ...(req.query.until ? { created_at_lte: Number(req.query.until) } : {}),
    };
    const vectorFilters = hasSemanticSearchFilters(metadataFilters) ? metadataFilters : undefined;

    const sanitized = sanitizeFtsQuery(query);
    const embeddingManager = deps.resolveEmbeddingManager?.(req.requestContext) ?? deps.embeddingManager;

    // --- Canopy branch ---
    // `type=canopy` is its own retrieval surface: a fixed namespace
    // (`canopy_entries`), per-file row shape (`{project_id, path,
    // llm_description, language, score}`), and llm_description hydrated from
    // the canopy_entries row instead of vector metadata. Local-only — canopy
    // is per-machine and not synced to team, so no team-client merge here.
    if (type === 'canopy') {
      // Canopy is project-scoped: with no resolved project there is nothing to
      // search, so return empty.
      if (typeof projectId !== 'string') {
        return { body: { mode: 'semantic', results: [] } };
      }
      const canopyResults = await searchCanopy(embeddingManager, {
        query,
        limit,
        threshold: SEARCH_SIMILARITY_THRESHOLD,
        project_id: projectId,
        language: req.query.language || undefined,
        db,
      });
      if (canopyResults === null) {
        return { body: { mode: 'semantic', results: [], provider_unavailable: true } };
      }
      return { body: { mode: 'semantic', results: normalizeSearchResults(canopyResults) } };
    }

    // --- FTS-only mode ---
    if (mode === 'fts') {
      try {
        const results = fullTextSearch(sanitized, { type, limit, scope, db });
        return { body: { mode: 'fts', results: normalizeSearchResults(results) } };
      } catch (err) {
        return {
          status: 500,
          body: {
            error: 'fts_query_failed',
            message: errorMessage(err),
            query,
            sanitized_query: sanitized !== query ? sanitized : undefined,
          },
        };
      }
    }

    // --- Semantic or auto mode: attempt vector search ---
    const searchNamespace = normalizeSearchNamespace(namespace ?? type);

    const queryVector = await embeddingManager.embedQuery(query);

    // If provider unavailable, auto falls back to FTS; semantic returns empty
    if (queryVector === null) {
      if (mode === 'auto') {
        try {
          const results = fullTextSearch(sanitized, { type, limit, scope, db });
          return { body: { mode: 'fts', results: normalizeSearchResults(results), fallback: true } };
        } catch (err) {
          return {
            status: 500,
            body: {
              error: 'fts_fallback_failed',
              message: errorMessage(err),
              query,
              sanitized_query: sanitized !== query ? sanitized : undefined,
            },
          };
        }
      }
      // mode === 'semantic' but no provider
      return { body: { mode: 'semantic', results: [], provider_unavailable: true } };
    }

    // Vector search with optional namespace/type filtering
    const vectorResults = embeddingManager.searchVectors(queryVector, {
      namespace: searchNamespace,
      limit,
      threshold: SEARCH_SIMILARITY_THRESHOLD,
      filters: vectorFilters,
    });

    const filteredVectorResults = vectorFilters
      ? vectorResults.filter((result) => matchesSemanticSearchFilters(result.metadata, metadataFilters))
      : vectorResults;

    // Hydrate local vector results into full SearchResults
    const localResults = hydrateSearchResults(filteredVectorResults, { scope, db }).map((r) => ({
      ...r,
      source: 'local',
    }));

    return { body: { mode: 'semantic', results: normalizeSearchResults(localResults) } };
}

function openRequestDatabase(requestContext?: MycoRequestContext): Database | undefined {
  if (!requestContext?.databasePath) return undefined;
  return openDatabase(requestContext.databasePath);
}
