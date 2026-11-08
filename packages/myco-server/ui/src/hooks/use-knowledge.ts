import { useMemo } from 'react';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import type {
  PlanBoardPage, PlanBoardRow, PlanFields, PlanPageAnswer, SporeArticleAnswer, SporeFacets, SporeStreamPage, SporeStreamRow,
} from '../features/knowledge/wire';
import { fetchJson } from '../lib/api';
import { live } from '../lib/live';

const seg = (value: string) => encodeURIComponent(value);

/** How many spores one page of the stream holds. */
export const SPORE_STREAM_PAGE = 25;

export interface SporeStreamFilters {
  /** One project, or null for every project. */
  projectId: string | null;
  /** One spore type, or undefined for every type. */
  type?: string;
  /** One status, or undefined for every status. */
  status?: string;
  /** Spores saved at or after this instant (ms). */
  since?: number;
}

/** The query string of one page of the stream; the server filters, and the first page carries the facets. */
export function sporeStreamPath(filters: SporeStreamFilters, cursor: string | null = null): string {
  const params = new URLSearchParams();
  if (filters.projectId !== null) params.set('project', filters.projectId);
  if (filters.type) params.set('type', filters.type);
  if (filters.status) params.set('status', filters.status);
  if (filters.since !== undefined) params.set('since', String(filters.since));
  params.set('limit', String(SPORE_STREAM_PAGE));
  if (cursor !== null) params.set('cursor', cursor);
  return `/api/spores?${params}`;
}

/**
 * The spore stream, newest first, a page at a time: "Show more" continues after
 * the last spore shown, by the cursor the page answered, so a spore saved
 * meanwhile neither repeats a row nor skips one. The facets and the total come
 * with the first page, from the counts Myco keeps; `counting` says it is still
 * counting older spores.
 */
export function useSporeStream(filters: SporeStreamFilters) {
  const first = sporeStreamPath(filters);
  const query = useInfiniteQuery({
    queryKey: ['spore-stream', first],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchJson<SporeStreamPage>(sporeStreamPath(filters, pageParam), signal),
    getNextPageParam: (last) => (last.hasMore && last.cursor !== null ? last.cursor : undefined),
    ...live({ follows: ['knowledge', 'runs'] }),
  });
  const rows = useMemo(() => [...new Map((query.data?.pages.flatMap((page) => page.spores) ?? []).map((row) => [`${row.projectId}/${row.id}`, row])).values()], [query.data]);
  const head = query.data?.pages[0];
  return {
    rows: rows as SporeStreamRow[],
    total: head?.total,
    counting: head?.counting === 'building',
    facets: head?.facets as SporeFacets | undefined,
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    more: () => { void query.fetchNextPage({ cancelRefetch: false }); },
    retry: () => { void query.refetch(); },
  };
}

/** One spore with its lineage. It shares its cache with every other read of the same spore. */
export function useSporeArticle(projectId: string, sporeId: string) {
  return useQuery({
    queryKey: ['spore', projectId, sporeId],
    queryFn: ({ signal }) => fetchJson<SporeArticleAnswer>(`/api/projects/${seg(projectId)}/spores/${seg(sporeId)}`, signal),
    ...live({ follows: ['knowledge'] }),
  });
}

/** The spores a lineage names, each read on its own so the article can name them by their line; one that is gone reads as missing. */
export function useSporeNeighbours(projectId: string, ids: readonly string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ['spore', projectId, id],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchJson<SporeArticleAnswer>(`/api/projects/${seg(projectId)}/spores/${seg(id)}`, signal),
      ...live({ follows: ['knowledge'] }),
    })),
  });
}

/** How many plans a board column reads at a time. */
export const PLAN_COLUMN_PAGE = 8;

/**
 * One column of the plans board: one status, newest edit first, a page at a
 * time. The first page carries how many plans of every status there are, from
 * the counts Myco keeps, so the column shows its total whatever is loaded.
 */
export function usePlanColumn(projectId: string | null, status: string) {
  const params = new URLSearchParams({ status, limit: String(PLAN_COLUMN_PAGE) });
  if (projectId !== null) params.set('project', projectId);
  const path = `/api/plans?${params}`;
  const query = useInfiniteQuery({
    queryKey: ['plans', path],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchJson<PlanBoardPage>(pageParam === null ? path : `${path}&cursor=${seg(pageParam)}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
    ...live({ follows: ['knowledge', 'runs'] }),
  });
  const rows = useMemo(() => [...new Map((query.data?.pages.flatMap((page) => page.plans) ?? []).map((row) => [`${row.projectId}/${row.planKey}`, row])).values()], [query.data]);
  return {
    rows: rows as PlanBoardRow[],
    /** How many plans hold this status; undefined until the first page is read, and while Myco is still counting. */
    total: query.data?.pages[0]?.counting === 'building' ? undefined : query.data?.pages[0]?.totals?.[status] ?? (query.data === undefined ? undefined : 0),
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    more: () => { void query.fetchNextPage({ cancelRefetch: false }); },
    retry: () => { void query.refetch(); },
  };
}

/** Where a plan's page is. */
export function planPagePath(projectId: string, plan: { planKey: string }): string {
  return `/p/${seg(projectId)}/plans/${seg(plan.planKey)}`;
}

/** One plan, with its tags, from `GET /api/projects/{p}/plans/{planKey}`. A plan the project does not hold answers 404. */
export function usePlan(projectId: string, planKey: string) {
  return useQuery({
    queryKey: ['plan', projectId, planKey],
    queryFn: async ({ signal }): Promise<PlanFields> => (await fetchJson<PlanPageAnswer>(`/api/projects/${seg(projectId)}/plans/${seg(planKey)}`, signal)).plan,
    ...live({ follows: ['knowledge'] }),
  });
}
