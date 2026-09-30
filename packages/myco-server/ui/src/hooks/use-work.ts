import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../lib/api';
import type { TodaySporePage, WorkAnswer } from '../features/today/wire';
import type { SessionResponse } from './use-sessions';
import type { DispatchAnswer, RunDetailAnswer, RunPage, RunPageRow } from '../features/work/wire';
import { usePaged } from './use-paged';

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

const seg = (value: string) => encodeURIComponent(value);

/** Whether a run is still to finish: waiting in the queue or running now. */
export function runIsLive(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'claimed';
}

/** How many of a task's latest runs an outcome lists under it. */
export const TASK_RUNS_SHOWN = 6;

/** A project's latest runs of one task, newest first, polling while `live`. */
export function useTaskRuns(projectId: string, task: string, live: boolean, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['runs', projectId, 'task', task],
    queryFn: ({ signal }) => fetchJson<RunPage>(`/api/projects/${seg(projectId)}/runs?${new URLSearchParams({ task, limit: String(TASK_RUNS_SHOWN) })}`, signal),
    ...freshness(live),
  });
}

/**
 * One run with what it read and produced, read again while it is still to
 * finish, never while the tab is hidden. A watcher passes `enabled` and
 * `retry` to follow a run that may not have been claimed yet.
 */
export function useRunDetail(projectId: string, runId: string, options: { enabled?: boolean; retry?: boolean } = {}) {
  return useQuery({
    ...options,
    queryKey: ['run', projectId, runId],
    queryFn: ({ signal }) => fetchJson<RunDetailAnswer>(`/api/projects/${seg(projectId)}/runs/${seg(runId)}`, signal),
    refetchInterval: (query) => (query.state.data !== undefined && runIsLive(query.state.data.run.status) ? LIVE_REFRESH_MS : false),
    refetchIntervalInBackground: false,
  });
}

/** What a dispatch asks for: the task, and for an admin, whether to run it even over input that has not moved. */
export interface DispatchAsk {
  task: string;
  fresh: boolean;
}

/** Starts one task in a project. Every reading of Myco's work is asked again once it lands, so the new run shows. */
export function useDispatchTask(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ task, fresh }: DispatchAsk) => postJson<DispatchAnswer>('/api/harness/dispatch', { projectId, task, ...(fresh ? { fresh: true } : {}) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['work'] });
      void client.invalidateQueries({ queryKey: ['runs', projectId] });
    },
  });
}

/** The spores written over a window, across every project or in one, newest first: an outcome's evidence is the ones its runs wrote. */
export function useWindowSpores(projectId: string | null, since: number, until: number, enabled = true) {
  const params = new URLSearchParams({ since: String(since), until: String(until), limit: String(WINDOW_SPORES) });
  if (projectId !== null) params.set('project', projectId);
  return useQuery({
    queryKey: ['work-spores', projectId ?? 'all', since, until],
    enabled,
    queryFn: ({ signal }) => fetchJson<TodaySporePage>(`/api/spores?${params}`, signal),
  });
}

/** The most spores one window's evidence reads. */
export const WINDOW_SPORES = 200;

/** Several sessions, each read on its own and sharing its cache with the session's page. */
export function useSessionsById(sessions: ReadonlyArray<{ projectId: string; sessionId: string }>) {
  return useQueries({
    queries: sessions.map(({ projectId, sessionId }) => ({
      queryKey: ['session', projectId, sessionId],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchJson<SessionResponse>(`/api/projects/${seg(projectId)}/sessions/${seg(sessionId)}`, signal),
    })),
  });
}

/** Myco's work over a window, read again every `LIVE_REFRESH_MS` only while one of its runs is queued or running, never from a hidden tab. */
export function useWorkWhileRunning(query: Omit<WorkQuery, 'live'>, options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['work', query.projectId ?? 'all', query.since, query.until],
    queryFn: ({ signal }) => fetchJson<WorkAnswer>(workPath(query), signal),
    refetchInterval: (state) => (workHasLiveRun(state.state.data) ? LIVE_REFRESH_MS : false),
    refetchIntervalInBackground: false,
  });
}

/** Whether any run the window counts is still to finish: queued or running. */
export function workHasLiveRun(answer: WorkAnswer | undefined): boolean {
  return (answer?.outcomes ?? []).some((outcome) => ['queued', 'running', 'claimed'].some((status) => (outcome.runs[status] ?? 0) > 0));
}

/** How many of a task's runs one page of "Show all" reads. */
export const TASK_RUN_PAGE = 20;

/** Every run of one task in a project, newest first, a page at a time on the server's cursor, read once it is wanted. */
export function useAllTaskRuns(projectId: string, task: string, enabled: boolean) {
  const path = `/api/projects/${seg(projectId)}/runs?${new URLSearchParams({ task, limit: String(TASK_RUN_PAGE) })}`;
  return usePaged<RunPageRow>(['runs', projectId, 'all', task], path, { enabled, rowKey: (row) => row.id });
}
