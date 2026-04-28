import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

/** Minimum query length before a search request is issued. */
const SEARCH_MIN_LENGTH = 2;

/** How long search results remain fresh in the cache (ms). */
const SEARCH_STALE_TIME = 30_000;

export interface SearchResult {
  id: string;
  type: string;
  title: string;
  preview: string;
  score: number;
  session_id?: string;
  // Canopy-specific fields populated when `type === 'canopy'` (a hit from the
  // unified All branch routed through `hydrateSearchResults`). Keeping them on
  // the shared shape lets the existing CanopyResultRow render canopy hits
  // coming from BOTH the dedicated Canopy facet and the All facet without
  // branching.
  project_id?: string | null;
  path?: string | null;
  language?: string | null;
  llm_description?: string | null;
}

/**
 * Canopy results have a different shape than the generic SearchResult — the
 * daemon returns per-file rows (path, llm_description, language, score)
 * keyed by project_id rather than vault id. The "Files" facet routes through
 * `type=canopy` and renders these rows directly. See `daemon/api/search.ts`
 * for the backend branch.
 */
export interface CanopySearchResult {
  type: 'canopy';
  project_id: string | null;
  path: string | null;
  llm_description: string | null;
  language: string | null;
  score: number;
}

export type AnySearchResult = SearchResult | CanopySearchResult;

export interface SearchResponse {
  mode: string;
  results: SearchResult[];
  error?: string;
}

export interface CanopySearchResponse {
  mode: string;
  results: Array<Omit<CanopySearchResult, 'type'>>;
  provider_unavailable?: boolean;
  error?: string;
}

export type SemanticRecentWindow = 'any' | '24h' | '7d' | '30d';

export interface SemanticSearchUiFilters {
  namespace?: string;
  observationType?: string;
  recentWindow?: SemanticRecentWindow;
}

export interface CanopySearchUiFilters {
  language?: string;
}

export function getSemanticSince(window: SemanticRecentWindow): number | undefined {
  const now = Math.floor(Date.now() / 1000);
  switch (window) {
    case '24h':
      return now - (24 * 60 * 60);
    case '7d':
      return now - (7 * 24 * 60 * 60);
    case '30d':
      return now - (30 * 24 * 60 * 60);
    default:
      return undefined;
  }
}

export function buildSearchPath(
  query: string,
  mode: 'semantic' | 'fts',
  filters?: SemanticSearchUiFilters,
): string {
  const params = new URLSearchParams({ q: query, mode });
  if (mode === 'semantic' && filters) {
    if (filters.namespace && filters.namespace !== 'all') {
      params.set('namespace', filters.namespace);
    }
    if (filters.observationType && filters.observationType !== 'all') {
      params.set('observation_type', filters.observationType);
    }
    const since = getSemanticSince(filters.recentWindow ?? 'any');
    if (since !== undefined) {
      params.set('since', String(since));
    }
  }
  return `/search?${params.toString()}`;
}

/**
 * Build the daemon search path for canopy/files queries. Routes through the
 * same `/search` endpoint as semantic/fts but pins `type=canopy`, which the
 * daemon handles via a dedicated branch (see `daemon/api/search.ts`).
 */
export function buildCanopySearchPath(
  query: string,
  filters?: CanopySearchUiFilters,
): string {
  const params = new URLSearchParams({ q: query, type: 'canopy' });
  if (filters?.language) {
    params.set('language', filters.language);
  }
  return `/search?${params.toString()}`;
}

export function useSearch(
  query: string,
  mode: 'semantic' | 'fts' = 'semantic',
  filters?: SemanticSearchUiFilters,
) {
  return useQuery<SearchResponse>({
    queryKey: ['search', query, mode, filters?.namespace ?? 'all', filters?.observationType ?? 'all', filters?.recentWindow ?? 'any'],
    queryFn: ({ signal }) =>
      fetchJson<SearchResponse>(
        buildSearchPath(query, mode, filters),
        { signal },
      ),
    enabled: query.length > SEARCH_MIN_LENGTH,
    staleTime: SEARCH_STALE_TIME,
  });
}

/**
 * Hook for the "Files" facet — fetches canopy entries by semantic similarity
 * to the user's query. The daemon returns per-file rows; we tag each with
 * `type: 'canopy'` so the unified results renderer can dispatch on it.
 */
export function useCanopySearch(
  query: string,
  filters?: CanopySearchUiFilters,
  enabled = true,
) {
  return useQuery<{ mode: string; results: CanopySearchResult[]; provider_unavailable?: boolean }>({
    queryKey: ['search-canopy', query, filters?.language ?? 'all'],
    queryFn: async ({ signal }) => {
      const raw = await fetchJson<CanopySearchResponse>(
        buildCanopySearchPath(query, filters),
        { signal },
      );
      return {
        mode: raw.mode,
        results: (raw.results ?? []).map((r) => ({ ...r, type: 'canopy' as const })),
        provider_unavailable: raw.provider_unavailable,
      };
    },
    enabled: enabled && query.length > SEARCH_MIN_LENGTH,
    staleTime: SEARCH_STALE_TIME,
  });
}
