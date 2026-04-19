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
}

export interface SearchResponse {
  mode: string;
  results: SearchResult[];
  error?: string;
}

export type SemanticRecentWindow = 'any' | '24h' | '7d' | '30d';

export interface SemanticSearchUiFilters {
  namespace?: string;
  observationType?: string;
  recentWindow?: SemanticRecentWindow;
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
