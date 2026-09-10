import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import type { PlanCardRow } from './use-sessions';

/** A plan as the Project's own list carries it: the captured plan plus the session it came from. */
export interface ProjectPlanRow extends PlanCardRow {
  sessionId: string;
  tags: string[];
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

/** Every plan this Project holds, newest edit first; one status, or all of them. */
export function useProjectPlans(projectId: string, status: string) {
  const query = status === 'all' ? '' : `&status=${encodeURIComponent(status)}`;
  return useQuery({
    queryKey: ['project-plans', projectId, status],
    queryFn: ({ signal }) =>
      fetchJson<{ plans: ProjectPlanRow[]; maxPage: number }>(
        `/api/projects/${encodeURIComponent(projectId)}/plans?limit=${PLAN_PAGE_SIZE}${query}`,
        signal,
      ),
  });
}
