import { useInfiniteQuery } from '@tanstack/react-query';
import type { SearchAnswer, SearchResult, SearchTurn } from '@goondocks/myco-shared/search-types';
import { fetchJson } from '../lib/api';
import { SEARCH_MIN_CHARS, searchPath } from './use-search';
import { live } from '../lib/live';

export interface ConversationHit {
  /** The turn's own id, unique among the hits, or the record's when no turn holds it. */
  key: string;
  preview: string;
  /** When the turn was captured, in epoch milliseconds. */
  at: number;
  /** The turn the hit opens, or null when its prompt is not one this session holds. */
  turn: SearchTurn | null;
}

const asHit = (result: SearchResult): ConversationHit => ({
  key: result.turn?.prompt_id ?? result.id,
  preview: result.preview,
  at: result.created_at,
  turn: result.turn ?? null,
});

/** The turn cards of one session a query matches, oldest first, each turn once. */
export function useConversationSearch(projectId: string, sessionId: string, query: string) {
  const enabled = query.length >= SEARCH_MIN_CHARS;
  const read = useInfiniteQuery({
    queryKey: ['conversation-search', projectId, sessionId, query],
    initialPageParam: null as string | null,
    enabled,
    queryFn: ({ pageParam, signal }) => fetchJson<SearchAnswer>(
      searchPath({ projectId }, { query, type: 'card', since: '', observationType: '', sessionId, mode: 'fts', order: 'time', ...(pageParam === null ? {} : { cursor: pageParam }) }),
      signal,
    ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...live('still'),
  });
  const hits = [...new Map((read.data?.pages.flatMap((page) => page.hits) ?? []).map(asHit).map((hit) => [hit.key, hit])).values()];
  return {
    hits,
    enabled,
    isPending: enabled && read.isPending,
    /** A first read that failed; a failed refresh or next page keeps `hits` and sets `staleError`. */
    error: read.isError && read.data === undefined ? read.error : null,
    staleError: read.isError && read.data !== undefined ? read.error : null,
    retry: () => { if (read.isFetchNextPageError) void read.fetchNextPage(); else void read.refetch(); },
    hasMore: read.hasNextPage,
    isFetchingMore: read.isFetchingNextPage,
    more: () => { void read.fetchNextPage({ cancelRefetch: false }); },
  };
}
