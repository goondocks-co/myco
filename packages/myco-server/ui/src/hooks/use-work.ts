import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../lib/api';
import type { TodaySporePage, WorkAnswer } from '../features/today/wire';
import type { SessionResponse } from './use-sessions';
import type { DispatchAnswer, RunAttempt, RunCall, RunCallPage, RunDetailAnswer, RunPage, RunPageRow, RunStep, RunStepPage } from '../features/work/wire';
import { MAX_RUN_STEPS } from '@goondocks/myco-shared/worker-steps';
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
export function useTaskRuns(projectId: string, task: string, live: boolean, enabled = true, bounds?: { since: number; until: number }) {
  return useQuery({
    enabled,
    queryKey: ['runs', projectId, 'task', task, bounds?.since, bounds?.until],
    queryFn: ({ signal }) => fetchJson<RunPage>(`/api/projects/${seg(projectId)}/runs?${new URLSearchParams({ task, limit: String(TASK_RUNS_SHOWN), ...(bounds === undefined ? {} : { since: String(bounds.since), until: String(bounds.until) }) })}`, signal),
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

/** Cancel one live run; every view of that run is refreshed from the server afterward. */
export function useCancelRun(projectId: string, runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<{ cancelled: true; runId: string }>(`/api/projects/${seg(projectId)}/runs/${seg(runId)}/cancel`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['run', projectId, runId] });
      void client.invalidateQueries({ queryKey: ['runs', projectId] });
      void client.invalidateQueries({ queryKey: ['work'] });
    },
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

/** Cursor pages of the run evidence; the first page is the Work read already on screen. */
export function useWorkEvidence(query: Omit<WorkQuery, 'live'>, first: WorkAnswer | undefined) {
  const path = workPath(query);
  const result = useInfiniteQuery({
    queryKey: ['work-evidence', query.projectId ?? 'all', query.since, query.until, first?.cursor, first?.runs[0]?.id],
    initialPageParam: null as string | null,
    initialData: first === undefined ? undefined : { pages: [first], pageParams: [null] },
    enabled: false,
    queryFn: ({ pageParam, signal }) => fetchJson<WorkAnswer>(
      pageParam === null ? path : `${path}&cursor=${encodeURIComponent(pageParam)}`, signal,
    ),
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  return {
    rows: first === undefined ? [] : [first.runs, ...(result.data?.pages.slice(1).map((page) => page.runs) ?? [])].flat(),
    hasMore: result.hasNextPage,
    isFetchingMore: result.isFetchingNextPage,
    error: result.error,
    expanded: (result.data?.pages.length ?? 0) > 1,
    more: () => { void result.fetchNextPage({ cancelRefetch: false }); },
  };
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

/** The most calls or steps one page reads: the server's page bound. */
export const EVIDENCE_PAGE = 200;

/** The most pages of calls a run's panel reads; past them, the list says what it holds. */
const MAX_CALL_PAGES = 50;

/** The pages an attempt's step log can span: every step it keeps, and one more page that finds the end. */
const MAX_STEP_PAGES = Math.ceil(MAX_RUN_STEPS / EVIDENCE_PAGE) + 1;

/** Rows read so far, and whether they are every row the server holds. */
export interface Loaded<T> {
  rows: readonly T[];
  complete: boolean;
  pending: boolean;
  error: unknown;
}

const NO_ROWS: readonly never[] = [];
const NOTHING = (): void => undefined;

/** Follow a cursor from a page in hand, one page at a time, up to `maxPages`. */
async function follow<T>(
  first: { rows: readonly T[]; cursor: string | null },
  maxPages: number,
  next: (cursor: string) => Promise<{ rows: readonly T[]; cursor: string | null }>,
): Promise<{ rows: readonly T[]; complete: boolean }> {
  const rows = [...first.rows];
  let cursor = first.cursor;
  for (let pages = 1; cursor !== null && pages < maxPages; pages += 1) {
    const page = await next(cursor);
    rows.push(...page.rows);
    cursor = page.cursor;
  }
  return { rows, complete: cursor === null };
}

/**
 * Every call a run made back to Myco, a page at a time from the page its detail carried: the run's panel lists them
 * all beside its steps, and checks the agent's account against them all.
 */
export function useAllRunCalls(projectId: string, runId: string, first: { rows: readonly RunCall[]; cursor: string | null; total: number }): Loaded<RunCall> {
  const query = useQuery({
    queryKey: ['run-calls', projectId, runId, first.total, first.rows.length],
    enabled: first.cursor !== null,
    queryFn: ({ signal }) => follow(first, MAX_CALL_PAGES, (cursor) => fetchJson<RunCallPage>(
      `/api/projects/${seg(projectId)}/runs/${seg(runId)}/calls?${new URLSearchParams({ cursor, limit: String(EVIDENCE_PAGE) })}`, signal)),
  });
  if (first.cursor === null) return { rows: first.rows, complete: true, pending: false, error: null };
  return { rows: query.data?.rows ?? first.rows, complete: query.data?.complete ?? false, pending: query.isPending, error: query.error };
}

/**
 * Every step of one attempt's log that Myco holds, a page at a time, from `first` where the run's detail carried the
 * attempt's first page. Read only while `enabled`, and only once a page of the log has arrived.
 */
export function useAttemptSteps(
  projectId: string, runId: string, attempt: RunAttempt | null, first: RunStepPage | null, enabled = true,
): Loaded<RunStep> & { refetch: () => void } {
  const has = attempt !== null && attempt.steps !== null && attempt.steps.received > 0;
  const start = first !== null && attempt !== null && first.attemptId === attempt.attemptId ? first : null;
  const query = useQuery({
    queryKey: ['run-steps', projectId, runId, attempt?.attemptId ?? null, attempt?.steps?.received ?? null, start?.rows.length ?? null],
    enabled: enabled && has,
    queryFn: async ({ signal }) => {
      const page = (cursor: string | null) => fetchJson<RunStepPage>(
        `/api/projects/${seg(projectId)}/runs/${seg(runId)}/steps?${new URLSearchParams({ attempt: attempt!.attemptId, limit: String(EVIDENCE_PAGE), ...(cursor === null ? {} : { cursor }) })}`,
        signal,
      );
      return follow(start ?? await page(null), MAX_STEP_PAGES, page);
    },
  });
  if (!has) return { rows: NO_ROWS, complete: true, pending: false, error: null, refetch: NOTHING };
  return { rows: query.data?.rows ?? NO_ROWS, complete: query.data?.complete ?? false, pending: query.isPending, error: query.error, refetch: () => void query.refetch() };
}
