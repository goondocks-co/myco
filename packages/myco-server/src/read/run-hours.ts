/**
 * The Runs page: when runs finished, per runner and hour, and what failed, grouped by cause, runner, agent and task
 * with each group's count in the window, in the window before it and per slice of the window. Every number is a sum
 * of the hourly counters; nothing here reads a run.
 */
import type { RelationalStore } from '../core/adapters.js';
import type { ProjectSet } from './scope.js';
import { endedRuns, runHourWindow, type EndedRunPage, type RunHourRow, type RunOutcome } from '../db/runs/hour-reads.js';
import { HOUR_MS } from '../db/runs/run-hours.js';
import type { RunResult } from '../db/runs/run-output.js';

/** The spans the page reads: a day by the hour, or a week by the day. */
export const RUN_WINDOWS = { day: { hours: 24, sliceHours: 1 }, week: { hours: 7 * 24, sliceHours: 24 } } as const;
export type RunWindow = keyof typeof RUN_WINDOWS;

const OUTCOME: Readonly<Record<RunResult, RunOutcome>> = { produced: 'worked', unchanged: 'unchanged', failed: 'failed', failed_with_output: 'failed' };

/** The dimensions failures are grouped by. */
export const FAILURE_DIMENSIONS = ['cause', 'runner', 'agent', 'task'] as const;
type FailureDimension = typeof FAILURE_DIMENSIONS[number];
const KEY_OF: Readonly<Record<FailureDimension, (row: RunHourRow) => string>> = {
  cause: (row) => row.error_code, runner: (row) => row.runner_id, agent: (row) => row.harness, task: (row) => row.task,
};

interface Counts { worked: number; unchanged: number; failed: number }
const empty = (): Counts => ({ worked: 0, unchanged: 0, failed: 0 });
/** '' in a counter row means the run recorded none; the page reads that as null. */
const named = (value: string): string | null => (value === '' ? null : value);

export interface RunHoursAnswer {
  window: { name: RunWindow; since: number; until: number; sliceMs: number };
  /** Whether every run that finished before the counts began is counted yet; until it is, earlier hours read low. */
  counted: boolean;
  totals: Counts & { waitedMs: number };
  /** One lane per runner (null for runs no runner ran), each hour that had a finished run. */
  lanes: { runnerId: string | null; name: string | null; hours: (Counts & { hour: number })[] }[];
  /** Per dimension, the groups that failed in this window or the one before it, most failures first. */
  failures: Record<FailureDimension, { key: string | null; name: string | null; runs: number; prior: number; slices: number[]; latestHour: number | null }[]>;
}

/** The current hour's window of `name`, ending after the hour `now` falls in. */
export function runWindow(name: RunWindow, now: number): { since: number; until: number } {
  const until = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
  return { since: until - RUN_WINDOWS[name].hours * HOUR_MS, until };
}

export async function readRunHours(db: RelationalStore, set: ProjectSet, name: RunWindow, now: number): Promise<RunHoursAnswer> {
  const { since, until } = runWindow(name, now);
  const span = until - since;
  const sliceMs = RUN_WINDOWS[name].sliceHours * HOUR_MS;
  const { rows, counted, runners } = await runHourWindow(db, set, since - span, until);
  const totals = { ...empty(), waitedMs: 0 };
  const lanes = new Map<string, Map<number, Counts>>();
  const groups = Object.fromEntries(FAILURE_DIMENSIONS.map((d) => [d, new Map<string, { runs: number; prior: number; slices: number[]; latestHour: number | null }>()])) as Record<FailureDimension, Map<string, { runs: number; prior: number; slices: number[]; latestHour: number | null }>>;
  for (const row of rows) {
    const outcome = OUTCOME[row.result];
    const current = row.hour >= since;
    if (current) {
      totals[outcome] += row.runs;
      totals.waitedMs += row.wait_ms;
      const lane = lanes.get(row.runner_id) ?? new Map<number, Counts>();
      lanes.set(row.runner_id, lane);
      const hour = lane.get(row.hour) ?? empty();
      lane.set(row.hour, hour);
      hour[outcome] += row.runs;
    }
    if (outcome !== 'failed') continue;
    for (const dimension of FAILURE_DIMENSIONS) {
      const key = KEY_OF[dimension](row);
      const group = groups[dimension].get(key) ?? { runs: 0, prior: 0, slices: Array.from({ length: span / sliceMs }, () => 0), latestHour: null };
      groups[dimension].set(key, group);
      if (!current) { group.prior += row.runs; continue; }
      group.runs += row.runs;
      group.slices[Math.floor((row.hour - since) / sliceMs)]! += row.runs;
      group.latestHour = Math.max(group.latestHour ?? row.hour, row.hour);
    }
  }
  const nameOf = (dimension: FailureDimension, key: string) => dimension === 'runner' ? runners.get(key) ?? null : null;
  return {
    window: { name, since, until, sliceMs },
    counted,
    totals,
    lanes: [...lanes].map(([runnerId, hours]) => ({
      runnerId: named(runnerId), name: runners.get(runnerId) ?? null,
      hours: [...hours].map(([hour, counts]) => ({ hour, ...counts })).sort((a, b) => a.hour - b.hour),
    })).sort((a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿')),
    failures: Object.fromEntries(FAILURE_DIMENSIONS.map((dimension) => [dimension, [...groups[dimension]]
      .map(([key, group]) => ({ key: named(key), name: nameOf(dimension, key), ...group }))
      .sort((a, b) => b.runs - a.runs || b.prior - a.prior)])) as RunHoursAnswer['failures'],
  };
}

/** The most runs one page of finished runs lists, and the page it lists when none is asked for. */
export const FINISHED_RUNS_PAGE = 50;

/** One finished run as the page lists it, with the runner that ran it. */
export interface FinishedRun {
  projectId: string; projectName: string | null; runId: string; task: string | null; result: RunResult; errorCode: string | null;
  harness: string | null; model: string | null; runner: { id: string; name: string | null } | null;
  queuedAt: number | null; startedAt: number | null; completedAt: number;
}

/**
 * A page of the runs that finished in the window, newest first, and the cursor of the next page; null when none is left.
 * A page that stopped at its inspection bound may list fewer rows than asked, none included, and still give a cursor.
 */
export async function readFinishedRuns(db: RelationalStore, set: ProjectSet, page: EndedRunPage) {
  const { rows, next } = await endedRuns(db, set, page);
  return {
    rows: rows.map((row): FinishedRun => ({
      projectId: row.project_id, projectName: row.project_name, runId: row.id, task: named(row.task), result: row.result, errorCode: named(row.error_code),
      harness: named(row.harness), model: row.model, runner: row.runner_id === '' ? null : { id: row.runner_id, name: row.runner_name },
      queuedAt: row.queued_at, startedAt: row.started_at, completedAt: Number(row.completed_at),
    })),
    cursor: next,
  };
}
