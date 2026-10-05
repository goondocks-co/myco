import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import type { Page } from './use-paged';
import type { TurnCollection } from './use-sessions';

/** An inline turn collection retains its first page and reads a continuation only on request. */
export function useTurnCollection<T>(projectId: string, sessionId: string, promptId: string, collection: TurnCollection, initial: T[], cursor: string | null | undefined) {
  const path = `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(promptId)}?collection=${collection}`;
  const query = useInfiniteQuery({
    queryKey: ['turn', projectId, sessionId, promptId, 'collection', collection, cursor ?? null],
    staleTime: Infinity,
    refetchOnMount: (cached) => (cached.state.data?.pages.length ?? 0) > 1 ? 'always' : false,
    initialPageParam: null as string | null,
    initialData: { pages: [{ rows: initial, cursor: cursor ?? null }], pageParams: [null] },
    queryFn: ({ pageParam, signal }) => fetchJson<Page<T>>(pageParam === null ? path : `${path}&cursor=${encodeURIComponent(pageParam)}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  return {
    rows: [initial, ...query.data.pages.slice(1).map((page) => page.rows)].flat(),
    hasMore: query.hasNextPage,
    pending: query.isFetchingNextPage,
    error: query.error,
    more: () => { void query.fetchNextPage({ cancelRefetch: false }); },
    retry: () => { if (query.isFetchNextPageError) void query.fetchNextPage({ cancelRefetch: false }); else void query.refetch(); },
  };
}
