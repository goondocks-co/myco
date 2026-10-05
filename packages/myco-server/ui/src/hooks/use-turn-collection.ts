import { useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import type { Page } from './use-paged';
import type { TurnCollection } from './use-sessions';

interface CollectionPage<T> extends Page<T> { embedded: boolean }

/** An embedded first page seeds a collection; opened collections retain and refresh their complete page set. */
export function useTurnCollection<T>(projectId: string, sessionId: string, promptId: string, collection: TurnCollection, initial: T[], cursor: string | null | undefined, rowKey: (row: T) => string) {
  const client = useQueryClient();
  const key = useMemo(() => ['turn', projectId, sessionId, promptId, 'collection', collection], [projectId, sessionId, promptId, collection]);
  const path = `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(promptId)}?collection=${collection}`;
  const query = useInfiniteQuery({
    queryKey: key,
    staleTime: Infinity,
    refetchOnMount: (cached) => cached.state.data?.pages.some((page) => !page.embedded) ? 'always' : false,
    initialPageParam: null as string | null,
    initialData: { pages: [{ rows: initial, cursor: cursor ?? null, embedded: true }], pageParams: [null] },
    queryFn: async ({ pageParam, signal }): Promise<CollectionPage<T>> => ({
      ...await fetchJson<Page<T>>(pageParam === null ? path : `${path}&cursor=${encodeURIComponent(pageParam)}`, signal),
      embedded: false,
    }),
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  const parent = useRef({ initial, cursor });
  const parentChanged = useRef(false);
  useEffect(() => {
    if (parent.current.initial !== initial || parent.current.cursor !== cursor) {
      parent.current = { initial, cursor };
      parentChanged.current = true;
    }
    const seed = query.data.pages.length === 1 && query.data.pages[0]!.embedded;
    if (seed && !query.isFetching && (query.data.pages[0]!.rows !== initial || query.data.pages[0]!.cursor !== (cursor ?? null))) {
      client.setQueryData<InfiniteData<CollectionPage<T>, string | null>>(key, (current) =>
        current?.pages.length === 1 && current.pages[0]!.embedded
          ? { ...current, pages: [{ rows: initial, cursor: cursor ?? null, embedded: true }] }
          : current);
      parentChanged.current = false;
    } else if (parentChanged.current && !query.isFetching) {
      parentChanged.current = false;
      if (!seed) void query.refetch();
    }
  }, [client, key, initial, cursor, query.data, query.isFetching, query.refetch]);
  const rows = useMemo(() => [...new Map(query.data.pages.flatMap((page) => page.rows).map((row) => [rowKey(row), row])).values()], [query.data, rowKey]);
  return {
    rows,
    hasMore: query.hasNextPage,
    pending: query.isFetchingNextPage,
    error: query.error,
    more: () => { void query.fetchNextPage({ cancelRefetch: false }); },
    retry: () => { if (query.isFetchNextPageError) void query.fetchNextPage({ cancelRefetch: false }); else void query.refetch(); },
  };
}
