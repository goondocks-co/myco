import { storageCleanupPending } from './storage-cleanup.js';
import { CONTENT_BLOB_LIMIT, CONTENT_WAKE_JOB_RESERVE, CONTENT_WALL_MS, measuredContentEnv } from './content-budget.js';
import { rawBackfillPending } from './raw-backfill.js';
/**
 * One wake of the Deployment's intelligence.
 *
 * A target delivers a wake — a hosted alarm, a cron floor, a process timer,
 * an owner pressing the button — and this is what every wake does:
 * read how long the Deployment has been idle, resolve the power state, run the
 * jobs due at that depth, and name the next instant to wake at. The mechanism
 * that delivers the wake is the only per-target part.
 *
 * A wake may arrive more than once for one instant, so the tick holds nothing
 * between calls: every input is read fresh, every job converges rather than
 * applies, and a second tick on the same clock changes nothing.
 */
import type { ServerEnv } from './adapters.js';
import { jobsDueAt, type TickWake } from './jobs.js';
import { JOB_IMPLEMENTATIONS } from './jobs-run.js';
import { DEFAULT_DISPATCH_TIMEOUT_SECONDS, RUN_OVERRUN_MARGIN_MS } from './harness.js';
import { nextWakeDelayMs, resolvePowerState, type PowerAssertion, type PowerState, type PowerThresholds, type WakeIntervals } from './power.js';
import { hasQueuedRun, hasRunInsideBound } from './runs.js';
import { drainQueue } from './harness.js';
import { runScheduledTasks, type ScheduleReport } from './scheduled-tasks.js';
import { lastActivityAt } from './activity.js';
import { classify, emit } from '../telemetry.js';
import { pendingSearchBlobs } from './search-index.js';
import { recoveryAttemptDue } from './recovery-schedule.js';
import { stagingPruneDue } from './staging-retention.js';
import { holdSettlementDue } from './recovery-hold.js';
import { pendingTranscripts, type TranscriptBacklog } from '../ingest/parse.js';
import { embeddingKeepsAwake } from './embedding/jobs.js';
import { anyMaintenanceDue } from './store-maintenance.js';

/** Inactivity before each depth: the same thresholds the 1.4 daemon applies on a machine. */
export const POWER_THRESHOLDS: PowerThresholds = { idleMs: 5 * 60_000, sleepMs: 30 * 60_000, deepSleepMs: 90 * 60_000 };
/** How long a woken Deployment waits before the next wake, by depth. Cadence, not a ceiling. */
export const WAKE_INTERVALS: WakeIntervals = { activeMs: 60_000, sleepMs: 5 * 60_000 };

export interface JobReport {
  name: string;
  /** Rows the job changed, or the class of the failure that stopped it. */
  changed: number;
  failed: string | null;
  /** Whether the job left work another pass would take, which chains the next wake. */
  more: boolean;
}

/**
 * How soon the next wake comes while a job reports work left, at any depth that schedules one: a backlog drains in
 * back-to-back passes, each bounded by its own budget, rather than one pass per cadence.
 */
export const CHAINED_WAKE_MS = 2_000;
export const WAKE_JOB_STATEMENT_LIMIT = 800;
export const WAKE_JOB_BLOB_LIMIT = 240;
const ARCHIVE_JOBS = new Set(['storage-content-cleanup', 'transcript-retention']);

export interface TickReport {
  state: PowerState;
  heldBy: string | null;
  /** Queued runs the tick launched as capacity allowed. */
  drained: number;
  /** What the clock dispatched and what it recorded as skipped this wake. */
  scheduled: ScheduleReport;
  /** Milliseconds of inactivity at this wake; null when the Deployment never saw activity. */
  idleMs: number | null;
  jobs: JobReport[];
  /** Milliseconds until the next wake this tick asks for; null in deep sleep, where nothing is scheduled. */
  nextWakeMs: number | null;
  /** The transcripts waiting to be read, as this wake counted them. */
  backlog: TranscriptBacklog;
  /** Whether this wake ran only the jobs that left work (`TickPacer`), rather than every job due. */
  drainOnly: boolean;
}

/**
 * What a target's own clock keeps between its wakes: when it last ran every job due, at what depth and with what
 * holding it there, and which jobs left work. A chained wake inside the cadence of the last full wake runs only the jobs
 * that left work (a backlog draining in back-to-back passes), and everything else waits for the next full wake, which
 * comes at the cadence as it would with no backlog at all. The sweeps, the leases, recovery, the schedule and every
 * other job therefore run no later than they would on a quiet Deployment. It is held in memory: a clock that loses it
 * runs every job on its next wake.
 */
export interface TickPacer {
  fullAt: number | null;
  state: PowerState | null;
  heldBy: string | null;
  idleMs: number | null;
  /** The jobs the last wake ran that left work. */
  draining: string[];
}

/** A clock's pacer before its first wake: that wake runs every job due. */
export function tickPacer(): TickPacer {
  return { fullAt: null, state: null, heldBy: null, idleMs: null, draining: [] };
}

/** Whether the wake at `now` runs only the jobs the pacer holds as draining. */
function drainOnlyAt(pacer: TickPacer | undefined, now: number): pacer is TickPacer & { fullAt: number; state: PowerState } {
  if (pacer === undefined || pacer.fullAt === null || pacer.state === null || pacer.draining.length === 0) return false;
  const cadence = nextWakeDelayMs(pacer.state, WAKE_INTERVALS);
  return cadence !== null && now - pacer.fullAt < cadence;
}

/** Runs `jobs` at `state`, reporting each as it ends. */
async function runJobs(env: ServerEnv, now: number, state: PowerState, jobs: readonly string[]): Promise<JobReport[]> {
  const reports: JobReport[] = [];
  const started = Date.now();
  const measured = measuredContentEnv(env, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: WAKE_JOB_BLOB_LIMIT,wallMs:CONTENT_WALL_MS });
  const ordered = [...jobs.filter(name => name === 'transcript-parse'),
    ...jobs.filter(name => name !== 'transcript-parse' && !ARCHIVE_JOBS.has(name)),
    ...jobs.filter(name => ARCHIVE_JOBS.has(name))];
  for (const name of ordered) {
    const run = JOB_IMPLEMENTATIONS[name];
    if (run === undefined) {
      reports.push({ name, changed: 0, failed: 'unimplemented', more: false });
      continue;
    }
    if (measured.usage.statements + CONTENT_WAKE_JOB_RESERVE > WAKE_JOB_STATEMENT_LIMIT
      || measured.usage.blobCalls + CONTENT_BLOB_LIMIT > WAKE_JOB_BLOB_LIMIT
      || (ARCHIVE_JOBS.has(name) && Date.now() - started >= CONTENT_WALL_MS)) {
      reports.push({ name, changed: 0, failed: null, more: true });
      continue;
    }
    try {
      const answered = await run(measured.env, now, state);
      const { changed, more } = typeof answered === 'number' ? { changed: answered, more: false } : answered;
      emit({ kind: 'job_ran', job: name, state, changed, more });
      reports.push({ name, changed, failed: null, more });
    } catch (err) {
      const failed = classify(err, env.platform?.classifyError);
      emit({ kind: 'job_failed', job: name, state, error_class: failed });
      reports.push({ name, changed: 0, failed, more: false });
    }
  }
  emit({ kind: 'wake_job_usage', ...measured.usage, elapsed_ms: Date.now() - started });
  return reports;
}

/** The queue's drain after the jobs: capacity the jobs freed is spent at once. */
async function drainAfterJobs(env: ServerEnv, now: number, state: PowerState): Promise<number> {
  try {
    return await drainQueue(env, now);
  } catch (err) {
    emit({ kind: 'drain_failed', state, error_class: classify(err, env.platform?.classifyError) });
    return 0;
  }
}

/** What the engine itself asserts about the Deployment's depth: a run inside its bound keeps it no deeper than idle. A run past its bound holds nothing — its runtime is gone, and the sweep is what it needs. One existence read, whatever the count. */
export async function engineAssertions(env: ServerEnv, now: number): Promise<PowerAssertion[]> {
  const [inside, queued] = await Promise.all([hasRunInsideBound(env.db, now, DEFAULT_DISPATCH_TIMEOUT_SECONDS, RUN_OVERRUN_MARGIN_MS), hasQueuedRun(env.db)]);
  const assertions: PowerAssertion[] = [];
  if (await storageCleanupPending(env.db)) assertions.push({ name: 'storage-cleanup:pending', maxDepth: 'idle' });
  if (await rawBackfillPending(env.db)) assertions.push({ name: 'raw-provenance:pending', maxDepth: 'sleep' });
  if (await pendingSearchBlobs(env.db) > 0) assertions.push({ name: 'search:pending', maxDepth: 'active' });
  const backlog = await pendingTranscripts(env.db, now);
  if (backlog.transcripts - backlog.imported.transcripts > 0) assertions.push({ name: 'transcript:pending', maxDepth: 'active' });
  if (backlog.imported.transcripts > 0) assertions.push({ name: 'import:pending', maxDepth: 'idle' });
  if (await embeddingKeepsAwake(env, now)) assertions.push({ name: 'embedding:pending', maxDepth: 'idle' });
  // Requested work that waits keeps the Deployment awake until it runs.
  if (queued) assertions.push({ name: 'queue:pending', maxDepth: 'active' });
  if (inside) assertions.push({ name: 'run:live', maxDepth: 'idle' });
  // A configured backup that is due keeps the Deployment no deeper than sleep, where the job that admits it
  // runs. An inactive Deployment therefore still takes its due attempt, and deep sleep still runs nothing.
  if (await recoveryAttemptDue(env, now)) assertions.push({ name: 'recovery:due', maxDepth: 'sleep' });
  // Staged payloads waiting to be released keep it there too, until the last of them has gone.
  if (await stagingPruneDue(env)) assertions.push({ name: 'recovery:prune', maxDepth: 'sleep' });
  // So does a producer hold nothing has settled: it defers deletion until the job that settles it runs.
  if (await holdSettlementDue(env)) assertions.push({ name: 'recovery:hold', maxDepth: 'sleep' });
  // A due store check holds it there as well, and stops holding once a run claims it: a run that fails consumes
  // its interval as one that succeeds does, so a check that cannot succeed never keeps the Deployment awake. A
  // maintenance record that cannot be read asserts nothing and is reported by name; every other job still runs,
  // and the check's own job meets the same fault when its depth runs it.
  try {
    if (await anyMaintenanceDue(env, now)) assertions.push({ name: 'maintenance:due', maxDepth: 'sleep' });
  } catch (err) {
    emit({ kind: 'maintenance_due_failed', error_class: classify(err, env.platform?.classifyError) });
  }
  return assertions;
}

/**
 * `wake` names which wake this tick is: a target's own clock passes `'clock'`; a tick an owner requests is `'request'`.
 * A clock also passes its `pacer`, which this tick reads to decide whether it drains only, and updates.
 */
export async function runTick(env: ServerEnv, now: number, options: { serverUrl?: string; wake?: TickWake; pacer?: TickPacer } = {}): Promise<TickReport> {
  const pacer = options.pacer;
  if (drainOnlyAt(pacer, now)) {
    const jobs = await runJobs(env, now, pacer.state, pacer.draining);
    // A queued run waits on no cadence: an owner's dispatch during a drain starts as it would at any other wake.
    const drained = await drainAfterJobs(env, now, pacer.state);
    pacer.draining = jobs.filter((j) => j.more).map((j) => j.name);
    const untilFull = Math.max(0, pacer.fullAt + nextWakeDelayMs(pacer.state, WAKE_INTERVALS)! - now);
    const nextWakeMs = pacer.draining.length > 0 ? Math.min(untilFull, CHAINED_WAKE_MS) : untilFull;
    const backlog = await pendingTranscripts(env.db, now);
    return { state: pacer.state, heldBy: pacer.heldBy, drained, scheduled: { dispatched: 0, skipped: 0 }, idleMs: pacer.idleMs, jobs, nextWakeMs, backlog, drainOnly: true };
  }
  const last = await lastActivityAt(env.db);
  const idleMs = last === null ? null : Math.max(0, now - last);
  const assertions = await engineAssertions(env, now);
  const resolved = resolvePowerState(idleMs ?? Number.POSITIVE_INFINITY, POWER_THRESHOLDS, assertions);

  const jobs = await runJobs(env, now, resolved.state, jobsDueAt(resolved.state, options.wake ?? 'request').map((job) => job.name));

  // The clock's own dispatches, then the drain: a scheduled task past a limit joins the queue this same wake.
  let scheduled: ScheduleReport = { dispatched: 0, skipped: 0 };
  if (resolved.state !== 'deep_sleep') {
    // A clock has no request in hand; the origin the operator declared is where its runs call back to.
    const serverUrl = options.serverUrl ?? env.origin ?? null;
    if (serverUrl === null) emit({ kind: 'schedule_skipped', state: resolved.state, skip: 'no_origin' });
    else {
      try {
        scheduled = await runScheduledTasks(env, resolved.state, now, serverUrl);
      } catch (err) {
        emit({ kind: 'schedule_failed', state: resolved.state, error_class: classify(err, env.platform?.classifyError) });
      }
    }
  }

  // Capacity the jobs freed is spent at once; a queue that stays held waits for the next wake.
  const drained = await drainAfterJobs(env, now, resolved.state);

  // Work a job left is taken by a wake soon after this one; the cadence is the longest the next wake waits.
  const cadence = nextWakeDelayMs(resolved.state, WAKE_INTERVALS);
  const nextWakeMs = cadence !== null && jobs.some((j) => j.more) ? Math.min(cadence, CHAINED_WAKE_MS) : cadence;
  const backlog = await pendingTranscripts(env.db, now);
  if (pacer !== undefined) Object.assign(pacer, { fullAt: now, state: resolved.state, heldBy: resolved.heldBy, idleMs, draining: jobs.filter((j) => j.more).map((j) => j.name) });
  return { state: resolved.state, heldBy: resolved.heldBy, drained, scheduled, idleMs, jobs, nextWakeMs, backlog, drainOnly: false };
}
