import { useMemo } from 'react';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import type {
  PlanBoardPage, PlanBoardRow, PlanFields, PlanPageAnswer, SporeArticleAnswer, SporeFacets, SporeStreamPage, SporeStreamRow,
} from '../features/knowledge/wire';
import { fetchJson } from '../lib/api';

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
  /** Matches the body or the type. */
  q?: string;
  /** Spores saved at or after this instant (ms). */
  since?: number;
}

/** The query string of one page of the stream; the server filters, and the first page carries the facets. */
export function sporeStreamPath(filters: SporeStreamFilters, offset = 0): string {
  const params = new URLSearchParams();
  if (filters.projectId !== null) params.set('project', filters.projectId);
  if (filters.type) params.set('type', filters.type);
  if (filters.status) params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  if (filters.since !== undefined) params.set('since', String(filters.since));
  params.set('limit', String(SPORE_STREAM_PAGE));
  if (offset > 0) params.set('offset', String(offset));
  return `/api/spores?${params}`;
}

/**
 * The spore stream, newest first, a page at a time by offset. "Show more" reads
 * the next page from where the loaded rows end; the facets and the total come
 * with the first page, so they describe the whole match, not what is loaded.
 */
export function useSporeStream(filters: SporeStreamFilters) {
  const first = sporeStreamPath(filters);
  const query = useInfiniteQuery({
    queryKey: ['spore-stream', first],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => fetchJson<SporeStreamPage>(sporeStreamPath(filters, pageParam), signal),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.spores.length, 0);
      return last.spores.length > 0 && loaded < (pages[0]?.total ?? 0) ? loaded : undefined;
    },
  });
  // A spore saved between two pages shifts the offsets; it is listed once, where it was first read.
  const rows = useMemo(() => [...new Map((query.data?.pages.flatMap((page) => page.spores) ?? []).map((row) => [`${row.projectId}/${row.id}`, row])).values()], [query.data]);
  const head = query.data?.pages[0];
  return {
    rows: rows as SporeStreamRow[],
    total: head?.total,
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
  });
}

/** The spores a lineage names, each read on its own so the article can name them by their line; one that is gone reads as missing. */
export function useSporeNeighbours(projectId: string, ids: readonly string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ['spore', projectId, id],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchJson<SporeArticleAnswer>(`/api/projects/${seg(projectId)}/spores/${seg(id)}`, signal),
    })),
  });
}

/** How many plans a board column reads at a time. */
export const PLAN_COLUMN_PAGE = 8;

/**
 * One column of the plans board: one status, newest edit first, a page at a
 * time, narrowed to the plans whose title or text match `q` when it is given.
 * The first page counts the plans of every status under the same filters, so
 * the column shows its total whatever is loaded.
 */
export function usePlanColumn(projectId: string | null, status: string, q: string | null) {
  const params = new URLSearchParams({ status, limit: String(PLAN_COLUMN_PAGE) });
  if (projectId !== null) params.set('project', projectId);
  if (q !== null && q !== '') params.set('q', q);
  const path = `/api/plans?${params}`;
  const query = useInfiniteQuery({
    queryKey: ['plans', path],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchJson<PlanBoardPage>(pageParam === null ? path : `${path}&cursor=${seg(pageParam)}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  const rows = useMemo(() => [...new Map((query.data?.pages.flatMap((page) => page.plans) ?? []).map((row) => [`${row.projectId}/${row.planKey}`, row])).values()], [query.data]);
  return {
    rows: rows as PlanBoardRow[],
    /** How many plans of this status the filters admit; undefined until the first page is read. */
    total: query.data?.pages[0]?.totals?.[status] ?? (query.data === undefined ? undefined : 0),
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
  });
}
