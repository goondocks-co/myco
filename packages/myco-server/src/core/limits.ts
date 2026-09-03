/**
 * The Deployment's dispatch limits, and what holds a dispatch back.
 *
 * A limit is a Settings leaf, never a number in the code: unset means
 * unbounded. A dispatch past a limit is queued and drained as capacity
 * returns — the run is the unit of work, and a constraint changes when it
 * runs, never whether.
 */
import type { RelationalStore } from './adapters.js';
import { leafValues } from './settings.js';

/** The name of the limit that holds a queued run, as the row records it and the dashboard reads it. */
export type HeldBy = 'concurrent_runs' | 'task_concurrent_runs' | 'task_runs_per_hour' | 'fleet';

export const LIMIT_LEAVES: Readonly<Record<HeldBy, string>> = {
  concurrent_runs: 'agent.limits.concurrent_runs',
  task_concurrent_runs: 'agent.limits.task_concurrent_runs',
  task_runs_per_hour: 'agent.limits.task_runs_per_hour',
  fleet: 'agent.limits.fleet',
};

/** Each limit as set, or null where the Deployment sets none. */
export type DispatchLimits = Readonly<Record<HeldBy, number | null>>;

/** What the Deployment is doing when a dispatch asks to run. */
export interface DispatchLoad {
  /** Runs live anywhere on the Deployment — pending or running. */
  liveRuns: number;
  /** Runs of this task live anywhere on the Deployment. */
  liveTaskRuns: number;
  /** Runs of this task that started in the trailing hour, whatever they became. */
  taskRunsLastHour: number;
}

const positiveInt = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
};

export async function readDispatchLimits(db: RelationalStore): Promise<DispatchLimits> {
  const byLeaf = await leafValues(db, Object.values(LIMIT_LEAVES));
  return {
    concurrent_runs: positiveInt(byLeaf.get(LIMIT_LEAVES.concurrent_runs)),
    task_concurrent_runs: positiveInt(byLeaf.get(LIMIT_LEAVES.task_concurrent_runs)),
    task_runs_per_hour: positiveInt(byLeaf.get(LIMIT_LEAVES.task_runs_per_hour)),
    fleet: positiveInt(byLeaf.get(LIMIT_LEAVES.fleet)),
  };
}

/**
 * The first limit the load is at, or null when the dispatch may launch now.
 * Pure: the same load and limits always name the same holder, and the order
 * is the order the row names it in — the fleet first, as the hardest bound.
 */
export function heldBy(load: DispatchLoad, limits: DispatchLimits): HeldBy | null {
  if (limits.fleet !== null && load.liveRuns >= limits.fleet) return 'fleet';
  if (limits.concurrent_runs !== null && load.liveRuns >= limits.concurrent_runs) return 'concurrent_runs';
  if (limits.task_concurrent_runs !== null && load.liveTaskRuns >= limits.task_concurrent_runs) return 'task_concurrent_runs';
  if (limits.task_runs_per_hour !== null && load.taskRunsLastHour >= limits.task_runs_per_hour) return 'task_runs_per_hour';
  return null;
}

/** Each holder in the reader's words. */
export const HELD_BY_WORDS: Readonly<Record<HeldBy, string>> = {
  concurrent_runs: 'the limit on runs at once',
  task_concurrent_runs: 'the limit on runs of this task at once',
  task_runs_per_hour: 'the limit on runs of this task per hour',
  fleet: 'the size of the fleet',
};
