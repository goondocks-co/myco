import { useMemo } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SearchAcrossAnswer, SearchAcrossResult, SearchAnswer, SearchResult } from '@goondocks/myco-shared/search-types';
import { SEARCH_API_LIMIT, SEARCH_TYPES } from '@goondocks/myco-shared/search-types';
import { ApiError, fetchJson } from '../lib/api';
import { planPagePath } from './use-knowledge';
import { live } from '../lib/live';

export type { SearchResult, SearchAcrossResult };
/** The kinds of record a search answers with. */
export { SEARCH_TYPES };
export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_MIN_CHARS = 2;
/** How many results one search lists at most: the server's own cap, asked for explicitly. */
export const SEARCH_RESULT_CAP = SEARCH_API_LIMIT;

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
  /** A record's status (a spore's, a plan's, or a session's `active` or `completed`), or every status when absent. */
  status?: string;
  /** The agent of the session a match belongs to. */
  agent?: string;
  /** The branch of the session a match belongs to. */
  branch?: string;
  /** Limits a project's search to the records of one session. */
  sessionId?: string;
  /** How a project's search matches: by meaning where it can (`auto`, the default) or by words alone (`fts`). */
  mode?: 'auto' | 'fts';
  /** How a project's search lists its matches: best of the newest first (the default), or oldest first; both continue by `cursor`. */
  order?: 'relevance' | 'time';
  /** The cursor an earlier answer to this search returned: the answer then lists the matches after it. */
  cursor?: string;
}

/** A search's answer with every hit carrying the project it belongs to. */
export type ScopedSearchAnswer = Omit<SearchAnswer, 'hits'> & { hits: SearchAcrossResult[] };

/** The request a search sends: a project's own search (which may answer by meaning), or the one across every project (words only). */
export function searchPath(scope: SearchScope, { query, type, since, observationType, status, agent, branch, sessionId, mode = 'auto', order, cursor }: SearchFilters): string {
  const params = new URLSearchParams({ q: query, type, limit: String(SEARCH_RESULT_CAP) });
  if (since) params.set('since', since);
  if (observationType) params.set('observation_type', observationType);
  if (status) params.set('status', status);
  if (agent) params.set('agent', agent);
  if (branch) params.set('branch', branch);
  if (sessionId && scope !== 'all') params.set('session_id', sessionId);
  if (order && scope !== 'all') params.set('order', order);
  if (cursor) params.set('cursor', cursor);
  if (scope === 'all') return `/api/search?${params}`;
  params.set('mode', mode);
  return `/api/projects/${encodeURIComponent(scope.projectId)}/search?${params}`;
}

export function useSearch(scope: SearchScope, filters: SearchFilters, enabled: boolean) {
  const path = searchPath(scope, filters);
  return useQuery({
    queryKey: ['search', scope === 'all' ? '*' : scope.projectId, path],
    queryFn: async ({ signal }): Promise<ScopedSearchAnswer> => {
      if (scope === 'all') return fetchJson<SearchAcrossAnswer>(path, signal);
      const answer = await fetchJson<SearchAnswer>(path, signal);
      return { ...answer, hits: answer.hits.map((hit) => ({ ...hit, projectId: scope.projectId })) };
    },
    enabled: enabled && filters.query.length >= SEARCH_MIN_CHARS,
    ...live('still'),
  });
}

/**
 * Every match of a search, a page at a time by word: the best of the newest first, `more()` continuing by the cursor the
 * page answered, into older matches, until none follow. A search never counts its matches. A search's later pages
 * expire after a while; reading one then starts the walk again from the first page. The list does not follow capture:
 * `refresh()` reads it again.
 */
export function useSearchPages(scope: SearchScope, filters: Omit<SearchFilters, 'cursor' | 'order' | 'mode'>, enabled: boolean) {
  const client = useQueryClient();
  const first = searchPath(scope, { ...filters, mode: 'fts' });
  const key = ['search', scope === 'all' ? '*' : scope.projectId, 'pages', first] as const;
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    enabled: enabled && filters.query.length >= SEARCH_MIN_CHARS,
    queryFn: async ({ pageParam, signal }): Promise<ScopedSearchAnswer> => {
      const path = searchPath(scope, { ...filters, mode: 'fts', ...(pageParam === null ? {} : { cursor: pageParam }) });
      if (scope === 'all') return fetchJson<SearchAcrossAnswer>(path, signal);
      const answer = await fetchJson<SearchAnswer>(path, signal);
      return { ...answer, hits: answer.hits.map((hit) => ({ ...hit, projectId: scope.projectId })) };
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...live('still'),
  });
  const hits = useMemo(() => [...new Map((query.data?.pages.flatMap((page) => page.hits) ?? []).map((hit) => [`${hit.projectId}/${hit.type}/${hit.id}`, hit])).values()], [query.data]);
  const restart = () => client.resetQueries({ queryKey: key, exact: true });
  return {
    hits,
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    // A page already on its way is joined, never asked for again.
    more: () => { void query.fetchNextPage({ cancelRefetch: false }); },
    retry: () => { if (query.error instanceof ApiError && query.error.code === 'cursor_expired') void restart(); else void query.refetch(); },
    refresh: () => { void restart(); },
  };
}

/** Where a hit opens, or null when this dashboard has no page for it. */
export function searchResultPath(projectId: string, hit: SearchResult): string | null {
  const base = `/p/${encodeURIComponent(projectId)}`;
  const id = encodeURIComponent(hit.id);
  if (hit.type === 'spore') return `${base}/spores/${id}`;
  if (hit.type === 'plan') return planPagePath(projectId, { planKey: hit.id });
  if (hit.type !== 'session' && hit.type !== 'card') return null;
  const session = `${base}/sessions/${encodeURIComponent(hit.session_id ?? hit.id)}`;
  if (hit.prompt_id) return `${session}?${new URLSearchParams({ turn: hit.prompt_id })}`;
  return session;
}
