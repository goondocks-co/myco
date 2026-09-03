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
import { jobsDueAt } from './jobs.js';
import { JOB_IMPLEMENTATIONS } from './jobs-run.js';
import { DEFAULT_DISPATCH_TIMEOUT_SECONDS, RUN_OVERRUN_MARGIN_MS } from './harness.js';
import { nextWakeDelayMs, resolvePowerState, type PowerAssertion, type PowerState, type PowerThresholds, type WakeIntervals } from './power.js';
import { hasQueuedRun, hasRunInsideBound } from './runs.js';
import { drainQueue } from './harness.js';
import { runScheduledTasks, type ScheduleReport } from './scheduled-tasks.js';
import { lastActivityAt } from './activity.js';
import { classify, emit } from '../telemetry.js';

/** Inactivity before each depth: the same thresholds the 1.4 daemon applies on a machine. */
export const POWER_THRESHOLDS: PowerThresholds = { idleMs: 5 * 60_000, sleepMs: 30 * 60_000, deepSleepMs: 90 * 60_000 };
/** How long a woken Deployment waits before the next wake, by depth. Cadence, not a ceiling. */
export const WAKE_INTERVALS: WakeIntervals = { activeMs: 60_000, sleepMs: 5 * 60_000 };

export interface JobReport {
  name: string;
  /** Rows the job changed, or the class of the failure that stopped it. */
  changed: number;
  failed: string | null;
}

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
}

/** What the engine itself asserts about the Deployment's depth: a run inside its bound keeps it no deeper than idle. A run past its bound holds nothing — its runtime is gone, and the sweep is what it needs. One existence read, whatever the count. */
export async function engineAssertions(env: ServerEnv, now: number): Promise<PowerAssertion[]> {
  const [inside, queued] = await Promise.all([hasRunInsideBound(env.db, now, DEFAULT_DISPATCH_TIMEOUT_SECONDS, RUN_OVERRUN_MARGIN_MS), hasQueuedRun(env.db)]);
  const assertions: PowerAssertion[] = [];
  // Requested work that waits keeps the Deployment awake until it runs.
  if (queued) assertions.push({ name: 'queue:pending', maxDepth: 'active' });
  if (inside) assertions.push({ name: 'run:live', maxDepth: 'idle' });
  return assertions;
}

export async function runTick(env: ServerEnv, now: number, options: { serverUrl?: string } = {}): Promise<TickReport> {
  const last = await lastActivityAt(env.db);
  const idleMs = last === null ? null : Math.max(0, now - last);
  const assertions = await engineAssertions(env, now);
  const resolved = resolvePowerState(idleMs ?? Number.POSITIVE_INFINITY, POWER_THRESHOLDS, assertions);

  const jobs: JobReport[] = [];
  for (const job of jobsDueAt(resolved.state)) {
    const run = JOB_IMPLEMENTATIONS[job.name];
    if (run === undefined) {
      jobs.push({ name: job.name, changed: 0, failed: 'unimplemented' });
      continue;
    }
    try {
      const changed = await run(env, now);
      emit({ kind: 'job_ran', job: job.name, state: resolved.state, changed });
      jobs.push({ name: job.name, changed, failed: null });
    } catch (err) {
      const failed = classify(err, env.platform?.classifyError);
      emit({ kind: 'job_failed', job: job.name, state: resolved.state, error_class: failed });
      jobs.push({ name: job.name, changed: 0, failed });
    }
  }

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
  let drained = 0;
  try {
    drained = await drainQueue(env, now);
  } catch (err) {
    emit({ kind: 'drain_failed', state: resolved.state, error_class: classify(err, env.platform?.classifyError) });
  }

  return { state: resolved.state, heldBy: resolved.heldBy, drained, scheduled, idleMs, jobs, nextWakeMs: nextWakeDelayMs(resolved.state, WAKE_INTERVALS) };
}
