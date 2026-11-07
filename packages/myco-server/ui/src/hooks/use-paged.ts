import { useMemo } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { retryCursorRead } from './cursor-retry';
import { fetchJson } from '../lib/api';
import { live, type PagedFreshness } from '../lib/live';

export interface Page<T> { rows: T[]; cursor: string | null }

/**
 * A cursor-paged read, page after page; `more()` fetches the next while a cursor
 * remains. A read with `enabled: false` waits, pending, until it is wanted.
 *
 * `rowKey` lists a row once: its first position, its latest payload. A refresh
 * re-walks the loaded pages. `freshness` says when it is read again, as every
 * query does (`lib/live.ts`).
 */
export function usePaged<T, TPage extends Page<T> = Page<T>>(key: readonly unknown[], path: string, opts: { freshness: PagedFreshness; enabled?: boolean; rowKey?: (row: T) => string }) {
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: [...key],
    initialPageParam: null as string | null,
    enabled: opts.enabled ?? true,
    queryFn: ({ pageParam, signal }) =>
      fetchJson<TPage>(pageParam === null ? path : `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(pageParam)}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
    ...live(opts.freshness),
  });
  const rowKey = opts.rowKey;
  const rows = useMemo(() => {
    const flat = query.data?.pages.flatMap((p) => p.rows) ?? [];
    // A Map keeps the first insertion's position and the last write's value.
    return rowKey === undefined ? flat : [...new Map(flat.map((row) => [rowKey(row), row])).values()];
  }, [query.data, rowKey]);
  return {
    rows,
    pages: query.data?.pages,
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    // A page already on its way is joined, never asked for again.
    more: () => { void query.fetchNextPage({ cancelRefetch: false }); },
    retry: () => { void retryCursorRead(client, key, query.error, () => query.refetch()); },
  };
}
