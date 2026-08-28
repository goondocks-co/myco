/**
 * The scheduled work a Deployment runs, and the state each waits for.
 *
 * `power.ts` decides WHEN the Deployment is awake; this says WHAT runs at each
 * depth. Both are shared policy — the timer that delivers a wake is the only
 * per-target part, and it lives behind `WakeScheduler` (#913, #914).
 *
 * A job names the deepest state it still runs at. Housekeeping that costs
 * nothing but a query runs even while sleeping; anything that calls a model or
 * moves real volume waits for a Deployment that is actually in use.
 *
 * **Every job here must be idempotent.** A wake may be delivered more than once
 * for one scheduled instant, so a job that assumed exactly-once delivery would
 * double-count or double-delete on a repeat. Each of these is expressed as
 * "bring the world to this state" rather than "apply this change", which is
 * what makes a second delivery a no-op instead of a second effect.
 */
import type { PowerState } from './power.js';
import { POWER_STATE_DEPTH } from './power.js';

export interface ServerJob {
  name: string;
  /** The deepest power state this job still runs at. */
  runsThrough: PowerState;
  /** What the job converges toward, stated so the idempotence is checkable rather than asserted. */
  converges: string;
}

/** The four jobs #919 owns. Retention, backup and reconciliation jobs belong to #922, #923 and #917. */
export const SERVER_JOBS: readonly ServerJob[] = [
  {
    name: 'embedding-reconcile',
    // Embedding calls a model and costs money per row; a Deployment nobody is
    // using does not need its backlog cleared this minute.
    runsThrough: 'idle',
    converges: 'every embeddable row has a current embedding',
  },
  {
    name: 'session-maintenance',
    runsThrough: 'sleep',
    converges: 'no session is left open past its last receipt',
  },
  {
    name: 'agent-run-retention',
    runsThrough: 'sleep',
    converges: 'no agent run is older than the retention window',
  },
  {
    name: 'release-provenance-reconcile',
    runsThrough: 'sleep',
    converges: 'every release-state row reflects the git state it was checked against',
  },
];

const JOB_BY_NAME = new Map(SERVER_JOBS.map((j) => [j.name, j]));

/**
 * Whether a job runs at this state.
 *
 * Deep sleep runs nothing, and that follows from the declarations rather than
 * from a guard here: no job declares it runs that deep, so the depth comparison
 * excludes every one. A separate deep-sleep branch would read as the protection
 * while contributing none — a gate proved that removing it changed no answer.
 */
export function jobRunsAt(jobName: string, state: PowerState): boolean {
  const job = JOB_BY_NAME.get(jobName);
  if (job === undefined) return false;
  return POWER_STATE_DEPTH[state] <= POWER_STATE_DEPTH[job.runsThrough];
}

/** Every job due at this state, in declaration order. */
export function jobsDueAt(state: PowerState): readonly ServerJob[] {
  return SERVER_JOBS.filter((j) => jobRunsAt(j.name, state));
}
