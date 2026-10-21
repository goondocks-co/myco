import { useInfiniteQuery } from '@tanstack/react-query';
import type { SearchAnswer, SearchResult, SearchTurn } from '@goondocks/myco-shared/search-types';
import { fetchJson } from '../lib/api';
import { SEARCH_MIN_CHARS, searchPath } from './use-search';

/** The kinds of record a conversation holds: tool calls are never searched. */
const CONVERSATION_TYPES = ['prompt', 'response'] as const;
type ConversationType = (typeof CONVERSATION_TYPES)[number];
const INDEX_REFRESH_MS = 5000;

export interface ConversationHit {
  /** Unique among the hits. */
  key: string;
  type: ConversationType;
  preview: string;
  /** When the hit's own prompt or reply was captured, in epoch milliseconds. */
  at: number;
  /** The turn the hit opens, or null when its prompt is not one this session holds. */
  turn: SearchTurn | null;
}

/** One kind's matches in this session, page after page, by words. */
function useConversationPages(projectId: string, sessionId: string, query: string, type: ConversationType, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['conversation-search', projectId, sessionId, type, query],
    initialPageParam: null as string | null,
    enabled,
    queryFn: ({ pageParam, signal }) => fetchJson<SearchAnswer>(
      searchPath({ projectId }, { query, type, since: '', observationType: '', sessionId, mode: 'fts', order: 'time', ...(pageParam === null ? {} : { cursor: pageParam }) }),
      signal,
    ),
    getNextPageParam: (last) => last.cursor ?? undefined,
    refetchInterval: (state) => (state.state.data?.pages.at(-1)?.coverage.pending_blobs ?? 0) > 0 ? INDEX_REFRESH_MS : false,
  });
}

const asHit = (result: SearchResult): ConversationHit => ({
  key: `${result.type}:${result.id}`,
  type: result.type as ConversationType,
  preview: result.preview,
  at: result.created_at,
  turn: result.turn ?? null,
});

const byTime = (a: SearchResult, b: SearchResult) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Prompt and reply hits of one session by words, oldest first. Each kind pages on its own cursor, so a hit is listed once
 * both kinds have been read as far as its time: the list ends where the kind that has read the least ends.
 */
export function useConversationSearch(projectId: string, sessionId: string, query: string) {
  const enabled = query.length >= SEARCH_MIN_CHARS;
  const prompts = useConversationPages(projectId, sessionId, query, 'prompt', enabled);
  const replies = useConversationPages(projectId, sessionId, query, 'response', enabled);
  const reads = [prompts, replies];
  const read = reads.map((one) => one.data?.pages.flatMap((page) => page.results) ?? []);
  const frontiers = reads.flatMap((one, index) => one.hasNextPage && read[index]!.length > 0 ? [read[index]!.at(-1)!] : []);
  const frontier = frontiers.sort(byTime)[0];
  const seen = new Set<string>();
  const hits: ConversationHit[] = [];
  for (const result of read.flat().sort(byTime)) {
    if (frontier !== undefined && byTime(result, frontier) > 0) break;
    const hit = asHit(result);
    if (!seen.has(hit.key)) { seen.add(hit.key); hits.push(hit); }
  }
  const failedFirst = reads.find((one) => one.isError && one.data === undefined);
  const failedRefresh = reads.find((one) => one.isError && one.data !== undefined && !one.isFetchNextPageError);
  const failedMore = reads.find((one) => one.isFetchNextPageError);
  return {
    hits,
    enabled,
    isPending: enabled && reads.some((one) => one.isPending),
    error: failedFirst?.error ?? null,
    retry: () => { for (const one of reads) if (one.isError && one.data === undefined) void one.refetch(); },
    refreshError: failedRefresh?.error ?? null,
    retryRefresh: () => { for (const one of reads) if (one.isError && one.data !== undefined && !one.isFetchNextPageError) void one.refetch(); },
    moreError: failedMore?.error ?? null,
    retryMore: () => { for (const one of reads) if (one.isFetchNextPageError) void one.fetchNextPage(); },
    hasMore: reads.some((one) => one.hasNextPage),
    isFetchingMore: reads.some((one) => one.isFetchingNextPage),
    more: () => { for (const one of reads) if (one.hasNextPage) void one.fetchNextPage({ cancelRefetch: false }); },
    pendingBodies: Math.max(...reads.map((one) => one.data?.pages.at(-1)?.coverage.pending_blobs ?? 0)),
  };
}
