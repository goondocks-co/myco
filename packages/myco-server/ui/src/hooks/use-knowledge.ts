import { useMemo } from 'react';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import type { SearchAcrossAnswer } from '../../../src/read/search-types';
import type {
  PlanBoardPage, PlanBoardRow, PlanFields, ProjectPlanPage, SporeArticleAnswer, SporeFacets, SporeStreamPage, SporeStreamRow,
} from '../features/knowledge/wire';
import { ApiError, fetchJson } from '../lib/api';
import type { PlanRow } from './use-sessions';

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

/** One column of the plans board: one status, newest edit first, a page at a time. */
export function usePlanColumn(projectId: string | null, status: string, enabled: boolean) {
  const params = new URLSearchParams({ status, limit: String(PLAN_COLUMN_PAGE) });
  if (projectId !== null) params.set('project', projectId);
  const path = `/api/plans?${params}`;
  const query = useInfiniteQuery({
    queryKey: ['plans', path],
    initialPageParam: null as string | null,
    enabled,
    queryFn: ({ pageParam, signal }) => fetchJson<PlanBoardPage>(pageParam === null ? path : `${path}&cursor=${seg(pageParam)}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  const rows = useMemo(() => [...new Map((query.data?.pages.flatMap((page) => page.plans) ?? []).map((row) => [`${row.projectId}/${row.planKey}`, row])).values()], [query.data]);
  return {
    rows: rows as PlanBoardRow[],
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    more: () => { void query.fetchNextPage({ cancelRefetch: false }); },
    retry: () => { void query.refetch(); },
  };
}

/** The plans of one status whose words match, across every project or within one: the search's own, full text. */
export function usePlanSearch(projectId: string | null, status: string, q: string, enabled: boolean) {
  const params = new URLSearchParams({ q, type: 'plan', status, limit: '20' });
  if (projectId !== null) params.set('project', projectId);
  const path = `/api/search?${params}`;
  return useQuery({
    queryKey: ['search', 'plans', path],
    enabled,
    queryFn: ({ signal }) => fetchJson<SearchAcrossAnswer>(path, signal),
  });
}

/** Where a plan's page is. The session that wrote it rides along, so the page reads the plan in one request. */
export function planPagePath(projectId: string, plan: { planKey: string; sessionId: string | null }): string {
  const base = `/p/${seg(projectId)}/plans/${seg(plan.planKey)}`;
  return plan.sessionId === null ? base : `${base}?${new URLSearchParams({ session: plan.sessionId })}`;
}

/** A plan as its page reads it: the plan, and the session that wrote it. */
export type PlanWithSession = Omit<PlanFields, 'tags'> & { tags: string[] };

/** How many plans one read of a project's list asks for while looking for a plan. */
const PLAN_WALK_PAGE = 200;

/**
 * One plan. The session a link names is asked for its plans first; a link
 * without one, or one naming the wrong session, has the project's plans read a
 * page at a time until the plan is found. A plan the project does not hold
 * answers 404.
 */
export function usePlan(projectId: string, planKey: string, sessionHint: string | null) {
  return useQuery({
    queryKey: ['plan', projectId, planKey, sessionHint],
    queryFn: async ({ signal }): Promise<PlanWithSession> => {
      if (sessionHint !== null) {
        try {
          const page = await fetchJson<{ rows: PlanRow[]; cursor: string | null }>(`/api/projects/${seg(projectId)}/sessions/${seg(sessionHint)}/plans?limit=100`, signal);
          const found = page.rows.find((row) => row.planKey === planKey);
          if (found !== undefined) return { ...found, sessionId: sessionHint, tags: [] };
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
      }
      const base = `/api/projects/${seg(projectId)}/plans?limit=${PLAN_WALK_PAGE}`;
      let cursor: string | null = null;
      do {
        const page: ProjectPlanPage = await fetchJson<ProjectPlanPage>(cursor === null ? base : `${base}&cursor=${seg(cursor)}`, signal);
        const found = page.plans.find((row) => row.planKey === planKey);
        if (found !== undefined) return found;
        cursor = page.cursor;
      } while (cursor !== null);
      throw new ApiError(404, { error: 'not_found' });
    },
  });
}
