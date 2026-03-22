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

export function useSearch(query: string, mode: 'semantic' | 'fts' = 'semantic') {
  return useQuery<SearchResponse>({
    queryKey: ['search', query, mode],
    queryFn: ({ signal }) =>
      fetchJson<SearchResponse>(
        `/search?q=${encodeURIComponent(query)}&mode=${mode}`,
        { signal },
      ),
    enabled: query.length > SEARCH_MIN_LENGTH,
    staleTime: SEARCH_STALE_TIME,
  });
}
