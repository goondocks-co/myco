import { useMemo } from 'react';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

export interface Page<T> { rows: T[]; cursor: string | null }

/**
 * A cursor-paged read, page after page; `more()` fetches the next while a cursor
 * remains. A read with `enabled: false` waits, pending, until it is wanted.
 *
 * `rowKey` lists a row once: its first position, its latest payload. A refresh
 * re-walks the loaded pages. `refresh`, given the rows read so far, answers how
 * often to read them again, or false for never; a hidden tab never reads again.
 */
export function usePaged<T>(key: readonly unknown[], path: string, opts: { enabled?: boolean; rowKey?: (row: T) => string; refresh?: (rows: readonly T[]) => number | false } = {}) {
  const refresh = opts.refresh;
  const query = useInfiniteQuery({
    queryKey: [...key],
    initialPageParam: null as string | null,
    enabled: opts.enabled ?? true,
    ...(refresh === undefined ? {} : {
      refetchInterval: (q: { state: { data: InfiniteData<Page<T>> | undefined } }) => refresh(q.state.data?.pages.flatMap((p) => p.rows) ?? []),
      refetchIntervalInBackground: false,
    }),
    queryFn: ({ pageParam, signal }) =>
      fetchJson<Page<T>>(pageParam === null ? path : `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(pageParam)}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  const rowKey = opts.rowKey;
  const rows = useMemo(() => {
    const flat = query.data?.pages.flatMap((p) => p.rows) ?? [];
    // A Map keeps the first insertion's position and the last write's value.
    return rowKey === undefined ? flat : [...new Map(flat.map((row) => [rowKey(row), row])).values()];
  }, [query.data, rowKey]);
  return {
    rows,
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    more: () => { void query.fetchNextPage(); },
    retry: () => { void query.refetch(); },
  };
}
