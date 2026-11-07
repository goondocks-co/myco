import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { followedMarks, heartbeat, MARKS, watchPresence, type Mark } from '../lib/live';
import type { WorkNowAnswer } from '../features/now/wire';

export type { WorkNowAnswer } from '../features/now/wire';

/** `/api/work/now` over one project, or every project for null. */
export function workNowPath(projectId: string | null): string {
  return projectId === null ? '/api/work/now' : `/api/work/now?${new URLSearchParams({ project: projectId })}`;
}

/** Whether anything in an answer is running now. */
export const somethingRuns = (answer: WorkNowAnswer | undefined): boolean => (answer?.running.length ?? 0) > 0;

/**
 * Myco's work now, over one project or every project: the dashboard's heartbeat. The page's panel and the live
 * refresh read the same query, so showing it costs no second read.
 */
export function useWorkNow(projectId: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['work-now', projectId ?? 'all'],
    queryFn: ({ signal }) => fetchJson<WorkNowAnswer>(workNowPath(projectId), signal),
    enabled: options.enabled ?? true,
    ...heartbeat<WorkNowAnswer>(somethingRuns),
  });
}

/** The marks that moved from one answer to the next. */
export function movedMarks(before: WorkNowAnswer['marks'], after: WorkNowAnswer['marks']): Mark[] {
  return MARKS.filter((mark) => before[mark] !== after[mark]);
}

/**
 * The dashboard's live refresh: reads the heartbeat for the page's scope every tick, and when a mark moves re-reads
 * only the open queries that follow it. Mounted once, in the shell, for a signed-in member, with the project the
 * viewer's own list confirms (never an id only the path names) and held until that list answers.
 */
export function LiveRefresh({ projectId, enabled = true }: { projectId: string | null; enabled?: boolean }) {
  const client = useQueryClient();
  const now = useWorkNow(projectId, { enabled });
  const seen = useRef<{ scope: string | null; marks: WorkNowAnswer['marks'] } | null>(null);
  const marks = now.data?.marks;
  useEffect(() => watchPresence(), []);
  useEffect(() => {
    if (marks === undefined) return;
    const before = seen.current;
    seen.current = { scope: projectId, marks };
    if (before === null || before.scope !== projectId) return;
    const moved = movedMarks(before.marks, marks);
    if (moved.length === 0) return;
    void client.invalidateQueries({ predicate: (query) => followedMarks(query).some((mark) => moved.includes(mark)) });
  }, [client, projectId, marks?.runs, marks?.sessions, marks?.fleet]);
  return null;
}
