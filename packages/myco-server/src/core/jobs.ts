/**
 * Everything a Deployment schedules, in one place.
 *
 * Two kinds of scheduled work live here, and nothing schedules work anywhere
 * else: the tick's own jobs (`SERVER_JOBS`, implemented in `jobs-run.ts`) and
 * the tasks the clock dispatches to the harness (`TASK_SCHEDULE`, decided in
 * `scheduled-tasks.ts`). One wake — `tick.ts` — runs both. The timer that
 * delivers a wake is the only per-target part, and it lives behind
 * `WakeScheduler` (#913, #914); `tests/myco-server/one-scheduler.test.ts` holds
 * this registry to that: a task not declared here is a task nothing runs, and a
 * timer outside the wake path fails the gate by name.
 *
 * `power.ts` decides WHEN the Deployment is awake; this says WHAT runs at each
 * depth. A job names the deepest state it still runs at. Housekeeping that costs
 * nothing but a query runs even while sleeping; anything that calls a model or
 * moves real volume waits for a Deployment that is actually in use.
 *
 * **Every job here must be idempotent.** A wake may be delivered more than once
 * for one scheduled instant, so a job that assumed exactly-once delivery would
 * double-count or double-delete on a repeat. Each of these is expressed as
 * "bring the world to this state" rather than "apply this change", which is
 * what makes a second delivery a no-op instead of a second effect.
 */
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { declared } from './declared.js';
import type { PowerState } from './power.js';
import { POWER_STATE_DEPTH } from './power.js';
import { EXTRACTION_TASK, SEEDING_TASK, TITLING_TASK } from './task-catalogue.js';

export interface ServerJob {
  name: string;
  /** The deepest power state this job still runs at. */
  runsThrough: PowerState;
  /** What the job converges toward, stated so the idempotence is checkable rather than asserted. */
  converges: string;
}

/** The jobs the tick runs today; each has an implementation in `jobs-run.ts`, which a gate holds. */
export const SERVER_JOBS: readonly ServerJob[] = [
  {
    name: 'agent-run-retention',
    runsThrough: 'sleep',
    converges: 'no terminal, non-resumable agent run outlives the retention window, and its turns and reports go with it; a live or resumable run is never pruned',
  },
  {
    name: 'run-stale-sweep',
    runsThrough: 'sleep',
    converges: 'no run whose runtime went away stays live past its bound: each is failed by name and released as a finished run is',
  },
  {
    name: 'grant-expiry',
    runsThrough: 'sleep',
    converges: 'no External Agent grant past its expiry is left live: each is ended at the instant it expired and named as expired, and every row, agent and attribution survives',
  },
  { name: 'search-index', runsThrough: 'idle', converges: 'every referenced text blob has a complete full-text index' },
  { name: 'embedding-reconcile', runsThrough: 'idle', converges: 'every eligible project memory record has a current vector and settled spore hubness' },
  // #1158 join UX
  {
    name: 'invite-expiry',
    runsThrough: 'sleep',
    converges: 'no spent, revoked or expired enrollment authority outlives the retention window; a live invitation is untouched whatever its age',
  },
  // #1147 — transcript-first ingest
  {
    name: 'transcript-parse',
    runsThrough: 'idle',
    converges: 'every byte of every held transcript has been read into the rows it contains, or the transcript names the failure that stopped it; a transcript nothing can parse is read to its end and offered no further',
  },
  {
    name: 'session-titling',
    runsThrough: 'idle',
    converges: 'every unclaimed live session-end request with fully parsed material has a titling run; imported sessions are not automatically titled',
  },
  // #1151 — worker mode
  {
    name: 'worker-lease-sweep',
    runsThrough: 'sleep',
    converges: 'no run whose worker stopped renewing holds a lease past its expiry: each returns to the claim queue with its dispatch credential retired and the place in the queue it had already waited for; a run inside its lease is never taken from the worker holding it',
  },
  {
    name: 'transcript-retention',
    runsThrough: 'idle',
    converges: 'no raw transcript segment behind the parse cursor outlives the Deployment window, and no blob any row still references is removed while no blob nothing references is kept; a segment inside the window or ahead of the cursor, and every derived row, is never pruned',
  },
];

/** A job declared for a state, awaiting the child that gives it work. Nothing runs it; naming the owner keeps the table honest. */
export interface DeferredJob extends ServerJob {
  owner: string;
}

/** Declared with #919's engine, not yet given an implementation; a tick never sees these. */
export const DEFERRED_JOBS: readonly DeferredJob[] = [
  { name: 'session-maintenance', runsThrough: 'sleep', converges: 'no session is left open past its last receipt', owner: '#919' },
  { name: 'release-provenance-reconcile', runsThrough: 'sleep', converges: 'every release-state row reflects the git state it was checked against', owner: '#919' },
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

/** The states a scheduled task may run in, in the words the 1.4 task files use. */
export type ScheduleState = 'active' | 'idle' | 'sleep';

/**
 * When the clock runs a task. The shape is the 1.4 task file's `schedule`
 * block, carried field for field: interval, the states it runs in, a named
 * precondition, an accelerator that shortens the interval under backlog, a
 * per-day ceiling, and whether a cold Project still gets it. `overlap` is
 * the Deployment's own: a `skip` task never runs twice at once in a Project;
 * a `queue` task is dispatched and the queue holds it.
 */
export interface TaskSchedule {
  /** A schedule declared but switched off; absent means on. */
  enabled?: boolean;
  intervalSeconds: number;
  runIn: readonly ScheduleState[];
  preCondition?: string;
  accelerator?: { name: string; thresholds: { steady: number; accelerated: number } };
  maxRunsPerDay?: number;
  /** Daily automatic slots available only when the named condition passes. */
  reservedRunsPerDay?: { count: number; preCondition: string };
  runWhenCold?: boolean;
  overlap: 'skip' | 'queue';
}

/**
 * What the Deployment schedules, by task. A task is scheduled here only once
 * the Deployment serves its tool surface; every other retained task is null
 * until its child turns it on, and copies the task file's block when it does.
 * `container-smoke` is the harness health probe the 1.4 daemon ran daily as
 * `harness-health`: one call, one report, proof the runtime still works.
 */
export const TASK_SCHEDULE: Readonly<Record<string, TaskSchedule | null>> = {
  [MAP_TASK]: { enabled: false, intervalSeconds: 21_600, runIn: ['idle', 'sleep'], overlap: 'skip', maxRunsPerDay: 4 },
  'embedding-reconcile': null,
  'container-smoke': { intervalSeconds: 86_400, runIn: ['sleep'], overlap: 'skip', maxRunsPerDay: 2 },
  [EXTRACTION_TASK]: { intervalSeconds: 3600, runIn: ['idle', 'sleep'], overlap: 'skip', maxRunsPerDay: 12, reservedRunsPerDay: { count: 3, preCondition: 'has-recent-live-prompts' }, preCondition: 'has-unprocessed-prompts' },
  [SEEDING_TASK]: null,
  [TITLING_TASK]: null,
};

/** The schedule this Deployment declares for a task: the block, or null for a task it schedules nothing for and for a name it does not serve. */
export function declaredScheduleFor(task: string): TaskSchedule | null {
  return declared(TASK_SCHEDULE, task) ?? null;
}
