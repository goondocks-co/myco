import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import type { PlanCardRow } from './use-sessions';

/** A plan as the Project's own list carries it: the captured plan plus the session it came from. */
export interface ProjectPlanRow extends PlanCardRow {
  sessionId: string;
  tags: string[];
}

/**
 * Where one plan opens: its own session's plans, with the plan named.
 *
 * One function, two callers — the project overview's panel and a plan search hit.
 * A plan has no page of its own, so the destination is a shape rather than a
 * route, and a shape spelled out at each call site is one that drifts at one of
 * them.
 */
export function planPath(projectId: string, plan: { planKey: string; sessionId: string }): string {
  const search = new URLSearchParams({ tab: 'plans', plan: plan.planKey });
  return `/p/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(plan.sessionId)}?${search}`;
}

/** The statuses the page filters by, in the order it lists them. `all` is the page's own, not the server's. */
export const PLAN_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'completed', label: 'Completed' },
  { id: 'abandoned', label: 'Abandoned' },
] as const;

export const PLAN_PAGE_SIZE = 100;

/** The plans this Project holds, newest edit first, a page at a time; one status, or all of them. */
export function useProjectPlans(projectId: string, status: string) {
  const query = status === 'all' ? '' : `&status=${encodeURIComponent(status)}`;
  const path = `/api/projects/${encodeURIComponent(projectId)}/plans?limit=${PLAN_PAGE_SIZE}${query}`;
  const plans = useInfiniteQuery({
    queryKey: ['project-plans', projectId, status],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchJson<{ plans: ProjectPlanRow[]; cursor?: string | null; maxPage: number }>(pageParam === null ? path : `${path}&cursor=${encodeURIComponent(pageParam)}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  // A plan edited between two pages is listed once, where it was first read.
  const rows = useMemo(() => [...new Map((plans.data?.pages.flatMap((p) => p.plans) ?? []).map((plan) => [plan.planKey, plan])).values()], [plans.data]);
  return {
    rows,
    isPending: plans.isPending,
    error: plans.error,
    hasMore: plans.hasNextPage,
    isFetchingMore: plans.isFetchingNextPage,
    more: () => { void plans.fetchNextPage(); },
  };
}
