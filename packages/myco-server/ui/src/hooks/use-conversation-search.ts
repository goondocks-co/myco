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
      searchPath({ projectId }, { query, type, since: '', observationType: '', sessionId, mode: 'fts', ...(pageParam === null ? {} : { continuation: pageParam }) }),
      signal,
    ),
    getNextPageParam: (last) => last.continuation ?? undefined,
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

/**
 * Prompt and reply hits of one session by words. Each kind pages on its own continuation; a page of hits lists
 * its prompts and replies together by score, and the next page follows it.
 */
export function useConversationSearch(projectId: string, sessionId: string, query: string) {
  const enabled = query.length >= SEARCH_MIN_CHARS;
  const prompts = useConversationPages(projectId, sessionId, query, 'prompt', enabled);
  const replies = useConversationPages(projectId, sessionId, query, 'response', enabled);
  const reads = [prompts, replies];
  const pageCount = Math.max(...reads.map((read) => read.data?.pages.length ?? 0));
  const seen = new Set<string>();
  const hits: ConversationHit[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const page = reads.flatMap((read) => read.data?.pages[index]?.results ?? []).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    for (const result of page) {
      const hit = asHit(result);
      if (!seen.has(hit.key)) { seen.add(hit.key); hits.push(hit); }
    }
  }
  const failedFirst = reads.find((read) => read.isError && read.data === undefined);
  const failedMore = reads.find((read) => read.isFetchNextPageError);
  return {
    hits,
    enabled,
    isPending: enabled && reads.some((read) => read.isPending && !read.isError),
    error: failedFirst?.error ?? null,
    moreError: failedMore?.error ?? null,
    retry: () => { for (const read of reads) if (read.isError && read.data === undefined) void read.refetch(); },
    hasMore: reads.some((read) => read.hasNextPage),
    isFetchingMore: reads.some((read) => read.isFetchingNextPage),
    more: () => { for (const read of reads) if (read.hasNextPage) void read.fetchNextPage({ cancelRefetch: false }); },
    retryMore: () => { for (const read of reads) if (read.isFetchNextPageError) void read.fetchNextPage(); },
    pendingBodies: Math.max(...reads.map((read) => read.data?.pages.at(-1)?.coverage.pending_blobs ?? 0)),
  };
}
