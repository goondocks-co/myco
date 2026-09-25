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
  /**
   * The one wake that runs this job, when only one may: `'clock'` is the target's own timer — the hosted clock object's
   * wake, the self-hosted wake loop — and never a tick an owner requests. `jobsDueAt` applies it for every tick.
   */
  wake?: 'clock';
}

/** Which wake a tick is: the target's own clock, or one an owner asked for. */
export type TickWake = 'clock' | 'request';

/**
 * Work a wake continues before it reads storage.
 *
 * A continuation is not a second scheduler: it decides nothing about when work starts, and it may only advance
 * something already admitted. One kind of work makes the Deployment's own database unreadable
 * while it runs — a recovery export — so the tick's first read would fail and the attempt would stall. The clock
 * remains the only alarm owner; it calls each continuation declared here, then derives its next wake from the
 * soonest deadline the continuations and the tick ask for.
 */
export interface WakeContinuation {
  name: string;
  /** What it may advance. */
  advances: string;
  /** What it may never do, stated so the boundary is checkable rather than assumed. */
  never: string;
}

/** The job "Back up every" drives. This registry owns job names, so the name lives here. */
export const SCHEDULE_JOB = 'recovery-export-schedule';

/** The job that keeps the recovery store from growing without bound. */
export const STAGING_RETENTION_JOB = 'recovery-staging-retention';

export const WAKE_CONTINUATIONS: readonly WakeContinuation[] = [
  {
    name: 'recovery-export-continuation',
    advances: 'one already-admitted hosted recovery attempt, using only the producer\'s own checkpoint and staging store, so it keeps polling an export that makes the Deployment unreadable, stages the objects that export names, completes the staging, and resumes after a reset',
    never: 'admit an attempt, choose a backup cadence, run the tick, dispatch a task, or read the Deployment\'s database',
  },
] as const;

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
    converges: 'every live session-end request with fully parsed material has had its first titling attempt; a retry, and every other session, is the titling backfill\'s',
  },
  {
    name: 'titling-backfill',
    runsThrough: 'idle',
    converges: 'every ended, untitled session with fully parsed material is claimed, newest first, until it carries a title or workers have taken the attempt bound on it, inside the Deployment\'s daily titling ceiling and pace; a session its own capture owes a title always, a wholly imported one only while the backfill is on',
  },
  // #1151 — worker mode
  {
    name: 'worker-lease-sweep',
    runsThrough: 'sleep',
    converges: 'no run whose worker stopped renewing holds a lease past its expiry: each returns to the claim queue with its dispatch credential retired and the place in the queue it had already waited for; a run inside its lease is never taken from the worker holding it, and no observation of a worker unheard from for thirty days is kept, while a worker holding a live lease keeps its own',
  },
  {
    name: SCHEDULE_JOB,
    runsThrough: 'sleep',
    wake: 'clock',
    converges: 'a Deployment whose owner set "Back up every" admits one recovery attempt once that interval has passed since the last attempt started, and admits none otherwise: none while an attempt still advances, none while the setting is unset, and none on a Deployment that runs no producer. At most one attempt is ever admitted for one due interval, because admission opens the producer hold and a second admission finds the first attempt instead',
  },
  {
    name: STAGING_RETENTION_JOB,
    runsThrough: 'sleep',
    wake: 'clock',
    converges: 'a Deployment keeps the newest complete stagings its "Recovery stagings to keep" setting names and the newest failed one, and holds the staged payload of no other settled attempt: every file of each released staging is gone from the staging store, and each attempt keeps a tombstone carrying its hold token, its start and its refusal so a settled token still admits nothing and the cadence still reads its own history. Nothing advancing, nothing resting unconfirmed, nothing downloaded-only and nothing carrying a hold this Deployment holds open is ever released, and a store that refuses a delete leaves the staging and its cursors for the next pass',
  },
  // Stored object release and recovery holds
  {
    name: 'recovery-hold-release',
    runsThrough: 'sleep',
    converges: "no producer recovery hold stays open once the producer answers that the attempt carrying it advances no further, or that no attempt carries it and its token is retired; a hold whose attempt still advances, or whose producer cannot answer, stays open. An operator backup's hold is never settled here: its own operator releases it, and no age does",
  },
  {
    name: 'object-release-drain',
    runsThrough: 'sleep',
    wake: 'clock',
    converges: 'every journaled stored object is deleted by a store delete the store acknowledged, and only then is its journal row removed; no expired upload authority survives unjournaled; with no recovery hold open, every candidate a hold deferred is decided again against the rows; a registered object is never journaled',
  },
  // Store maintenance
  {
    name: 'database-optimize',
    runsThrough: 'sleep',
    wake: 'clock',
    converges: 'a Deployment whose owner turned automatic optimize on at an interval has had the store\'s query-planner statistics refreshed by its own target\'s optimize at least once per interval since the last run started, and the outcome of the latest run is recorded under its run id; a check this target does not support, one that is not configured, and one still running runs nothing',
  },
  {
    name: 'database-integrity-check',
    runsThrough: 'sleep',
    wake: 'clock',
    converges: 'a Deployment whose owner turned automatic integrity checking on at an interval has had its store checked by its own target\'s integrity and foreign key checks at least once per interval since the last run started, and the findings or the named failure of the latest run are recorded under its run id; a check this target does not support, one that is not configured, and one still running runs nothing',
  },
  {
    name: 'transcript-retention',
    runsThrough: 'idle',
    converges: 'no raw transcript segment behind the parse cursor outlives the Deployment window, and no blob any row still references is removed while no blob nothing references is kept; a segment inside the window or ahead of the cursor, and every derived row, is never pruned',
  },
  // Release provenance
  {
    name: 'release-provenance-reconcile',
    runsThrough: 'sleep',
    converges: "every enabled Project is checked once its reconcile interval has passed or its owner asked, within its GitHub lookup budget: each session's release state reflects its latest captured commit against the refs of that check, a released state changes only for a newer captured commit and keeps the state it replaced, one check holds a Project at a time and publishes only under the settings it read, and a check that cannot reach GitHub or read its stored data changes no state and records why on the Project",
  },
];

/** A job declared for a state, awaiting the child that gives it work. Nothing runs it; naming the owner keeps the table honest. */
export interface DeferredJob extends ServerJob {
  owner: string;
}

/** Declared with #919's engine, not yet given an implementation; a tick never sees these. */
export const DEFERRED_JOBS: readonly DeferredJob[] = [
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

/** Every job due at this state on this wake, in declaration order. A job that names its wake runs on that wake alone. */
export function jobsDueAt(state: PowerState, wake: TickWake): readonly ServerJob[] {
  return SERVER_JOBS.filter((j) => jobRunsAt(j.name, state) && (j.wake === undefined || j.wake === wake));
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
  [MAP_TASK]: { enabled: false, intervalSeconds: 21_600, runIn: ['idle', 'sleep'], overlap: 'skip', maxRunsPerDay: 4, preCondition: 'has-capture-since-map' },
  'embedding-reconcile': null,
  'container-smoke': { intervalSeconds: 86_400, runIn: ['sleep'], overlap: 'skip', maxRunsPerDay: 2 },
  [EXTRACTION_TASK]: { intervalSeconds: 3600, runIn: ['idle', 'sleep'], overlap: 'skip', maxRunsPerDay: 12, reservedRunsPerDay: { count: 3, preCondition: 'has-recent-live-prompts' }, preCondition: 'has-unprocessed-prompts' },
  [SEEDING_TASK]: null,
  [TITLING_TASK]: null,
};

/**
 * The block the titling convergence runs under, in the same vocabulary
 * and under the same `agent.tasks` override as every scheduled task:
 * `enabled`, off until an operator turns it on, admits wholly imported sessions,
 * `runIn` the power states a wake dispatches in, `maxRunsPerDay` a ceiling
 * counted across the Deployment by the backfill's actor, `intervalSeconds` the
 * least time between two wakes that dispatch, and `overlap: 'skip'` holds a
 * wake while a backfill run is still in flight. The `titling-backfill` job
 * reads it; the clock's per-Project loop does not.
 */
export const TITLING_BACKFILL_SCHEDULE: TaskSchedule = { enabled: false, intervalSeconds: 900, runIn: ['active', 'idle'], overlap: 'queue', maxRunsPerDay: 24 };

/** The schedule this Deployment declares for a task: the block, or null for a task it schedules nothing for and for a name it does not serve. */
export function declaredScheduleFor(task: string): TaskSchedule | null {
  return declared(TASK_SCHEDULE, task) ?? null;
}
