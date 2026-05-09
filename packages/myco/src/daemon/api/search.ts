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
  TEAM_SOURCE_PREFIX,
} from '@myco/constants.js';
import { hasSemanticSearchFilters, matchesSemanticSearchFilters } from '@myco/semantic-search-filters.js';
import { normalizeSearchResults } from '@myco/search-results.js';
import { searchCanopy } from '@myco/canopy/search.js';
import { projectScopeFromRequestContext, rowProjectIdFromRequestContext, type MycoRequestContext } from '@myco/tools/request-context.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { TeamSyncClient, TeamSearchResult } from '../team-sync.js';

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

/** Dependencies injected by the daemon when registering the route. */
export interface SearchDeps {
  embeddingManager: SearchEmbeddingManager;
  resolveEmbeddingManager?: (requestContext?: MycoRequestContext) => SearchEmbeddingManager;
  getTeamClient?: (requestContext?: MycoRequestContext) => TeamSyncClient | null;
  machineId?: string;
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
    // Fire team search in parallel with the embedding round-trip — both are
    // network-bound and team search depends only on the query string. On the
    // rare FTS fallback path the team response is discarded; the saved
    // round-trip on every successful semantic search is the better trade.
    const teamClient = deps.getTeamClient?.(req.requestContext);
    const teamSearchNamespace = normalizeSearchNamespace(namespace ?? type);
    const teamPromise = teamClient
      ? teamClient.search(query, {
          limit,
          tables: teamSearchNamespace ? [teamSearchNamespace] : undefined,
          status: req.query.status || undefined,
          observation_type: req.query.observation_type || undefined,
          since: req.query.since ? Number(req.query.since) : undefined,
          until: req.query.until ? Number(req.query.until) : undefined,
          session_id: req.query.session_id || undefined,
          project_id: typeof projectId === 'string' ? projectId : undefined,
        }).catch(() => null)
      : null;

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
      namespace: teamSearchNamespace,
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

    const teamResponse = teamPromise ? await teamPromise : null;
    const teamResults: Array<TeamSearchResult & { source: string }> = teamResponse
      ? teamResponse.results.map((r) => ({
          ...r,
          source: `${TEAM_SOURCE_PREFIX}${r.machine_id}`,
        }))
      : [];

    // Deduplicate: skip team results from this machine (we already have them locally)
    const dedupedTeam = deps.machineId
      ? teamResults.filter((r) => r.machine_id !== deps.machineId)
      : teamResults;

    const filteredTeam = vectorFilters
      ? dedupedTeam.filter((r) => matchesSemanticSearchFilters(
          (r as { metadata?: Record<string, unknown> }).metadata,
          metadataFilters,
        ))
      : dedupedTeam;

    // Merge by score (highest first), slice to limit
    const merged = [...localResults, ...filteredTeam]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);

    return { body: { mode: 'semantic', results: normalizeSearchResults(merged) } };
}

function openRequestDatabase(requestContext?: MycoRequestContext): Database | undefined {
  if (!requestContext?.databasePath) return undefined;
  return openDatabase(requestContext.databasePath);
}
