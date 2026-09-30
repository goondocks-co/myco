import { useQuery } from '@tanstack/react-query';
import type { SearchAcrossAnswer, SearchAcrossResult, SearchAnswer, SearchResult } from '../../../src/read/search-types';
import { SEARCH_API_LIMIT, SEARCH_TYPES } from '../../../src/read/search-types';
import { fetchJson } from '../lib/api';
import { planPagePath } from './use-knowledge';

export type { SearchResult, SearchAcrossResult };
/** The kinds of record a search answers with. */
export { SEARCH_TYPES };
export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_MIN_CHARS = 2;
/** How many results one search lists at most: the server's own cap, asked for explicitly. */
export const SEARCH_RESULT_CAP = SEARCH_API_LIMIT;
const SEARCH_INDEX_REFRESH_MS = 5000;

/** What a search covers: the one project picked, or every project. */
export type SearchScope = { projectId: string } | 'all';

export interface SearchFilters {
  query: string;
  /** A kind of record, or `all`. */
  type: string;
  /** Epoch seconds, or '' for any time. */
  since: string;
  /** A spore type, or ''. */
  observationType: string;
}

/** A search's answer with every result carrying the project it belongs to. */
export interface ScopedSearchAnswer {
  results: SearchAcrossResult[];
  mode: SearchAnswer['mode'];
  provider_unavailable: boolean;
  coverage: SearchAnswer['coverage'];
}

/** The request a search sends: a project's own search (which may answer by meaning), or the one across every project (words only). */
export function searchPath(scope: SearchScope, { query, type, since, observationType }: SearchFilters): string {
  const params = new URLSearchParams({ q: query, type, limit: String(SEARCH_RESULT_CAP) });
  if (since) params.set('since', since);
  if (observationType) params.set('observation_type', observationType);
  if (scope === 'all') return `/api/search?${params}`;
  params.set('mode', 'auto');
  return `/api/projects/${encodeURIComponent(scope.projectId)}/search?${params}`;
}

export function useSearch(scope: SearchScope, filters: SearchFilters, enabled: boolean) {
  const path = searchPath(scope, filters);
  return useQuery({
    queryKey: ['search', scope === 'all' ? '*' : scope.projectId, path],
    queryFn: async ({ signal }): Promise<ScopedSearchAnswer> => {
      if (scope === 'all') return fetchJson<SearchAcrossAnswer>(path, signal);
      const answer = await fetchJson<SearchAnswer>(path, signal);
      return { ...answer, results: answer.results.map((hit) => ({ ...hit, projectId: scope.projectId })) };
    },
    enabled: enabled && filters.query.length >= SEARCH_MIN_CHARS,
    refetchInterval: (state) => enabled && (state.state.data?.coverage.pending_blobs ?? 0) > 0 ? SEARCH_INDEX_REFRESH_MS : false,
  });
}

/**
 * Where a hit opens, or null when this dashboard has no page for it.
 *
 * A skill is read from the catalogue that ships with Myco rather than from a page
 * here, so a skill hit has no destination. Answering null is what lets the result
 * list show the hit and not pretend it is a link.
 */
export function searchResultPath(projectId: string, hit: SearchResult): string | null {
  const base = `/p/${encodeURIComponent(projectId)}`;
  const id = encodeURIComponent(hit.id);
  if (hit.type === 'spore') return `${base}/spores/${id}`;
  if (hit.type === 'skill') return null;
  if (hit.type === 'plan') return planPagePath(projectId, { planKey: hit.id, sessionId: hit.session_id ?? null });
  const session = `${base}/sessions/${encodeURIComponent(hit.session_id ?? hit.id)}`;
  if (hit.prompt_id) return `${session}?${new URLSearchParams({ turn: hit.prompt_id })}`;
  return session;
}
