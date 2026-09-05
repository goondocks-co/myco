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

/**
 * What holds a queued run, as the row records it and the dashboard reads it.
 *
 * Three are limits an owner sets, one is the size of what the operator
 * deployed, and `runtime` is none of those: it is a runtime that will not take
 * a run at this instant, which clears on its own rather than by raising
 * anything.
 */
export type HeldBy = 'concurrent_runs' | 'task_concurrent_runs' | 'task_runs_per_hour' | 'fleet' | 'runtime';

/** The holds that describe the Deployment rather than one task: a run behind any of them is behind every later run too. */
export const DEPLOYMENT_WIDE_HOLDS: ReadonlySet<HeldBy> = new Set<HeldBy>(['fleet', 'concurrent_runs', 'runtime']);

/** The three limits an owner sets in Settings. The fleet is the size of what the operator deployed; a runtime hold is not a limit at all. */
export const LIMIT_LEAVES: Readonly<Record<Exclude<HeldBy, 'fleet' | 'runtime'>, string>> = {
  concurrent_runs: 'agent.limits.concurrent_runs',
  task_concurrent_runs: 'agent.limits.task_concurrent_runs',
  task_runs_per_hour: 'agent.limits.task_runs_per_hour',
};

/** Each limit as set, or null where the Deployment sets none. A runtime hold has no number to compare against and is absent here. */
export type DispatchLimits = Readonly<Record<Exclude<HeldBy, 'runtime'>, number | null>>;

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

/** The limits as set: the owner's three from their leaves, the fleet from what the operator deployed. */
export async function readDispatchLimits(env: { db: RelationalStore; fleet?: number }): Promise<DispatchLimits> {
  const byLeaf = await leafValues(env.db, Object.values(LIMIT_LEAVES));
  return {
    concurrent_runs: positiveInt(byLeaf.get(LIMIT_LEAVES.concurrent_runs)),
    task_concurrent_runs: positiveInt(byLeaf.get(LIMIT_LEAVES.task_concurrent_runs)),
    task_runs_per_hour: positiveInt(byLeaf.get(LIMIT_LEAVES.task_runs_per_hour)),
    fleet: env.fleet !== undefined && Number.isInteger(env.fleet) && env.fleet >= 1 ? env.fleet : null,
  };
}

/**
 * The first limit the load is at, or null when the dispatch may launch now.
 * Pure: the same load and limits always name the same holder, and the order
 * is the order the row names it in — the fleet first, as the hardest bound.
 * A runtime hold is never decided here; it is what a launch answers.
 */
export function heldBy(load: DispatchLoad, limits: DispatchLimits): Exclude<HeldBy, 'runtime'> | null {
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
  runtime: 'the runtime is not taking a run right now',
};
