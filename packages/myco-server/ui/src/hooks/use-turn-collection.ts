import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import type { Page } from './use-paged';
import type { TurnCollection } from './use-sessions';

interface CollectionPage<T> extends Page<T> { embedded: boolean }

/** How many pages one ask for more reads when they hold no new row. */
const PAGES_PER_ASK = 4;

/** An embedded first page seeds a collection; opened collections retain and refresh their complete page set. */
export function useTurnCollection<T>(projectId: string, sessionId: string, promptId: string, collection: TurnCollection, initial: T[], cursor: string | null | undefined, rowKey: (row: T) => string, unloaded = false) {
  const client = useQueryClient();
  const key = useMemo(() => ['turn', projectId, sessionId, promptId, 'collection', collection], [projectId, sessionId, promptId, collection]);
  const path = `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(promptId)}?collection=${collection}`;
  const query = useInfiniteQuery({
    queryKey: key,
    staleTime: Infinity,
    refetchOnMount: (cached) => cached.state.data?.pages.some((page) => !page.embedded) ? 'always' : false,
    initialPageParam: null as string | null,
    initialData: unloaded ? undefined : { pages: [{ rows: initial, cursor: cursor ?? null, embedded: true }], pageParams: [null] },
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
    if (query.data === undefined) return;
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
  const rows = useMemo(() => [...new Map((query.data?.pages ?? []).flatMap((page) => page.rows).map((row) => [rowKey(row), row])).values()], [query.data, rowKey]);
  // A page can hold none of this collection's rows: one ask reads on until a new row, the turn's end or its bound.
  const asked = useRef<{ rows: number; pages: number } | null>(null);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const ask = asked.current;
    if (ask === null || query.isFetching) return;
    if (rows.length > ask.rows || !query.hasNextPage || query.isError) asked.current = null;
    else if (ask.pages >= PAGES_PER_ASK) {
      asked.current = null;
      setStalled(true);
    } else {
      ask.pages += 1;
      void query.fetchNextPage({ cancelRefetch: false });
    }
  }, [rows, query.hasNextPage, query.isFetching, query.isError, query.fetchNextPage]);
  return {
    rows,
    /** The last ask reached its bound with nothing new. */
    stalled,
    hasMore: query.hasNextPage,
    pending: query.isPending || query.isFetchingNextPage,
    error: query.error,
    more: () => {
      asked.current = { rows: rows.length, pages: 1 };
      setStalled(false);
      void query.fetchNextPage({ cancelRefetch: false });
    },
    retry: () => { if (query.isFetchNextPageError) void query.fetchNextPage({ cancelRefetch: false }); else void query.refetch(); },
  };
}
