import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

export interface Page<T> { rows: T[]; cursor: string | null }

/** A cursor-paged read, page after page; `more()` fetches the next while a cursor remains. Refetch, focus and remount all keep one copy of every row. A read with `enabled: false` waits, pending, until it is wanted. */
export function usePaged<T>(key: readonly unknown[], path: string, opts: { enabled?: boolean } = {}) {
  const query = useInfiniteQuery({
    queryKey: [...key],
    initialPageParam: null as string | null,
    enabled: opts.enabled ?? true,
    queryFn: ({ pageParam, signal }) =>
      fetchJson<Page<T>>(pageParam === null ? path : `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(pageParam)}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  return {
    rows: query.data?.pages.flatMap((p) => p.rows) ?? [],
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    more: () => { void query.fetchNextPage(); },
  };
}
