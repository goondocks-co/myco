/**
 * Search API handler — supports FTS, semantic, and auto modes.
 *
 * - mode=fts: FTS5 full-text search (prompt_batches + activities)
 * - mode=semantic: Vector similarity search via VectorStore (sessions, spores, plans, artifacts)
 * - mode=auto (default): Tries semantic first, falls back to FTS if provider unavailable
 */

import { fullTextSearch, hydrateSearchResults, sanitizeFtsQuery } from '@myco/db/queries/search.js';
import { errorMessage } from '@myco/utils/error-message.js';
import {
  SEARCH_RESULTS_DEFAULT_LIMIT,
  SEARCH_SIMILARITY_THRESHOLD,
  TEAM_SOURCE_PREFIX,
} from '@myco/constants.js';
import { hasSemanticSearchFilters, matchesSemanticSearchFilters } from '@myco/semantic-search-filters.js';
import { hydrateCanopyDescription } from '@myco/canopy/hydrate.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { TeamSyncClient, TeamSearchResult } from '../team-sync.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid search modes. */
type SearchMode = 'auto' | 'semantic' | 'fts';

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
  embeddingManager: EmbeddingManager;
  getTeamClient?: () => TeamSyncClient | null;
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
    const query = req.query.q;
    if (!query) return { status: 400, body: { error: 'missing_query' } };

    const mode = (req.query.mode ?? 'auto') as SearchMode;
    const type = req.query.type;
    const limit = Number(req.query.limit) || SEARCH_RESULTS_DEFAULT_LIMIT;
    const namespace = req.query.namespace;
    const metadataFilters = {
      ...(req.query.status ? { status: req.query.status } : {}),
      ...(req.query.session_id ? { session_id: req.query.session_id } : {}),
      ...(req.query.observation_type ? { observation_type: req.query.observation_type } : {}),
      ...(req.query.since ? { created_at_gte: Number(req.query.since) } : {}),
      ...(req.query.until ? { created_at_lte: Number(req.query.until) } : {}),
    };
    const vectorFilters = hasSemanticSearchFilters(metadataFilters) ? metadataFilters : undefined;

    const sanitized = sanitizeFtsQuery(query);

    // --- Canopy branch ---
    // `type=canopy` is its own retrieval surface: a fixed namespace
    // (`canopy_entries`), per-file row shape (`{project_id, path,
    // llm_description, language, score}`), and llm_description hydrated from
    // the canopy_entries row instead of vector metadata. Local-only — canopy
    // is per-machine and not synced to team, so no team-client merge here
    // (parity with the harness `vault_search_canopy` tool).
    if (type === 'canopy') {
      const queryVector = await deps.embeddingManager.embedQuery(query);
      if (queryVector === null) {
        return { body: { mode: 'semantic', results: [], provider_unavailable: true } };
      }
      const canopyFilters: Record<string, unknown> = {
        ...(req.query.language ? { language: req.query.language } : {}),
        ...(req.query.path_prefix ? { path_prefix: req.query.path_prefix } : {}),
      };
      const canopyVectorFilters = Object.keys(canopyFilters).length > 0 ? canopyFilters : undefined;
      const rawCanopy = deps.embeddingManager.searchVectors(queryVector, {
        namespace: 'canopy_entries',
        limit,
        threshold: SEARCH_SIMILARITY_THRESHOLD,
        filters: canopyVectorFilters,
      });
      const canopyResults = rawCanopy.map((r) => {
        const meta = (r.metadata ?? {}) as { project_id?: unknown; path?: unknown; language?: unknown };
        return {
          project_id: typeof meta.project_id === 'string' ? meta.project_id : null,
          path: typeof meta.path === 'string' ? meta.path : null,
          llm_description: hydrateCanopyDescription(r.id),
          language: typeof meta.language === 'string' ? meta.language : null,
          score: r.similarity,
        };
      });
      return { body: { mode: 'semantic', results: canopyResults } };
    }

    // --- FTS-only mode ---
    if (mode === 'fts') {
      try {
        const results = fullTextSearch(sanitized, { type, limit });
        return { body: { mode: 'fts', results } };
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
    const queryVector = await deps.embeddingManager.embedQuery(query);

    // If provider unavailable, auto falls back to FTS; semantic returns empty
    if (queryVector === null) {
      if (mode === 'auto') {
        try {
          const results = fullTextSearch(sanitized, { type, limit });
          return { body: { mode: 'fts', results, fallback: true } };
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
    const searchNamespace = normalizeSearchNamespace(namespace ?? type);
    const vectorResults = deps.embeddingManager.searchVectors(queryVector, {
      namespace: searchNamespace,
      limit,
      threshold: SEARCH_SIMILARITY_THRESHOLD,
      filters: vectorFilters,
    });

    const filteredVectorResults = vectorFilters
      ? vectorResults.filter((result) => matchesSemanticSearchFilters(result.metadata, metadataFilters))
      : vectorResults;

    // Hydrate local vector results into full SearchResults
    const localResults = hydrateSearchResults(filteredVectorResults).map((r) => ({
      ...r,
      source: 'local',
    }));

    // Fan out to team search in parallel (if connected)
    const teamClient = deps.getTeamClient?.();
    let teamResults: Array<TeamSearchResult & { source: string }> = [];
    if (teamClient) {
      try {
        const teamResponse = await teamClient.search(query, {
          limit,
          tables: searchNamespace ? [searchNamespace] : undefined,
          status: req.query.status || undefined,
          observation_type: req.query.observation_type || undefined,
          since: req.query.since ? Number(req.query.since) : undefined,
          until: req.query.until ? Number(req.query.until) : undefined,
          session_id: req.query.session_id || undefined,
        });
        teamResults = teamResponse.results.map((r) => ({
          ...r,
          source: `${TEAM_SOURCE_PREFIX}${r.machine_id}`,
        }));
      } catch {
        // Team search failure is non-blocking — local results still returned
      }
    }

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

    return { body: { mode: 'semantic', results: merged } };
  };
}
