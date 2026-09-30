import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import type { WorkAnswer } from '../features/today/wire';

export type { WorkAnswer, WorkOutcome, WorkRun, Upkeep, OutcomeKind, RunResult } from '../features/today/wire';

/** How often a page that shows what is happening now asks again. A hidden tab never asks; a returning one asks once. */
export const LIVE_REFRESH_MS = 30_000;

/** The polling a hook takes: every `LIVE_REFRESH_MS` while `live`, never while the tab is hidden. */
export function freshness(live: boolean): { refetchInterval: number | false; refetchIntervalInBackground: false } {
  return { refetchInterval: live ? LIVE_REFRESH_MS : false, refetchIntervalInBackground: false };
}

export interface WorkQuery {
  /** The Project to read, or null for every Project. */
  projectId: string | null;
  since: number;
  until: number;
  /** Whether the window reaches now, so the answer can still change. */
  live: boolean;
}

/** `/api/work` path for a window, over one Project or all of them. */
export function workPath({ projectId, since, until }: Pick<WorkQuery, 'projectId' | 'since' | 'until'>): string {
  const params = new URLSearchParams({ since: String(since), until: String(until) });
  if (projectId !== null) params.set('project', projectId);
  return `/api/work?${params}`;
}

/** Myco's work over a window: what its runs produced, the runs that produced it or failed, and the search index's upkeep. */
export function useWork(query: WorkQuery) {
  return useQuery({
    queryKey: ['work', query.projectId ?? 'all', query.since, query.until],
    queryFn: ({ signal }) => fetchJson<WorkAnswer>(workPath(query), signal),
    ...freshness(query.live),
  });
}
