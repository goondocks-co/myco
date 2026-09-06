import { useQuery } from '@tanstack/react-query';
import type { SearchAnswer, SearchResult } from '../../../src/read/search-types';
import { fetchJson } from '../lib/api';

export type { SearchResult };
export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_MIN_CHARS = 2;
const SEARCH_INDEX_REFRESH_MS = 5000;

interface SearchFilters { query: string; type: string; since: string; observationType: string }

export function useSearch(projectId: string, { query, type, since, observationType }: SearchFilters, enabled: boolean) {
  const params = new URLSearchParams({ q: query, type, mode: 'fts', limit: '20' });
  if (since) params.set('since', since);
  if (observationType) params.set('observation_type', observationType);
  return useQuery({
    queryKey: ['search', projectId, params.toString()],
    queryFn: ({ signal }) => fetchJson<SearchAnswer>(`/api/projects/${encodeURIComponent(projectId)}/search?${params}`, signal),
    enabled: enabled && query.length >= SEARCH_MIN_CHARS,
    refetchInterval: (state) => enabled && (state.state.data?.coverage.pending_blobs ?? 0) > 0 ? SEARCH_INDEX_REFRESH_MS : false,
  });
}

export function searchResultPath(projectId: string, hit: SearchResult): string {
  const base = `/p/${encodeURIComponent(projectId)}`;
  const id = encodeURIComponent(hit.id);
  if (hit.type === 'spore') return `${base}/spores/${id}`;
  if (hit.type === 'skill') return `${base}/skills/${id}`;
  const session = `${base}/sessions/${encodeURIComponent(hit.session_id ?? hit.id)}`;
  if (hit.type === 'plan') return `${session}?${new URLSearchParams({ tab: 'plans', plan: hit.id })}`;
  if (hit.prompt_id) return `${session}?${new URLSearchParams({ turn: hit.prompt_id })}`;
  return session;
}
