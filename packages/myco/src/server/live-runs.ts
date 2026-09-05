/**
 * What a Deployment has in flight, and the wait a deploy performs on it.
 *
 * Both targets read the same rows and wait the same way; only what spares a
 * run differs. On the Worker the platform drains a replaced instance and the
 * container application spares a run inside its own budget. On the self-hosted
 * stack the harness's `stop_grace_period` does it: the harness shares the
 * server's network namespace, so a recreate stops the harness first and its
 * runtimes finish inside that window. Either way the wait is what keeps the
 * operator's deploy from racing them, and each target hands in the words for
 * what carries a run it stopped waiting on.
 */
import { commandOutputTail, describeFailure, isCommandFailure } from './runner.js';

/** One run a Deployment has in flight. */
export interface LiveRun {
  id: string;
  task: string;
  /** `pending` for a run whose runtime has not been launched yet, `running` for one under way, `queued` for one the queue took back with its runtime still working. */
  status: 'pending' | 'running' | 'queued';
  /** Epoch milliseconds. Every row this read answers carries one: both writers of a live row stamp the instant its launch went out. */
  startedAt: number | null;
  /** When the row first joined the queue, in epoch milliseconds, for a run that waited; null for one that never did. */
  queuedAt: number | null;
  /** The budget the dispatcher wrote into the run's context, or null for a run that carries none. */
  timeoutSeconds: number | null;
}

/**
 * What the wait reads, in the spelling the columns carry.
 *
 * `pending` counts as in flight exactly as `running` does: the dispatcher
 * writes the row before it launches the runtime, and that run — admitted, not
 * yet started — is the one a deploy is most likely to lose. So does a queued
 * row that names a credential: a launch answered too late is taken back into
 * the queue while the child it started keeps working, and that child claims the
 * row it is still named on. A queued row naming none is a run behind a limit,
 * and the next wake dispatches it.
 *
 * The dispatcher's own fleet count reads the first pair alone (`core/runs.ts`,
 * `LIVE_RUN_STATUSES`): this read is about what a recreate would interrupt.
 */
export const LIVE_RUNS_QUERY = "SELECT id, task, status, started_at, queued_at, run_context FROM agent_runs WHERE status IN ('pending', 'running') OR (status = 'queued' AND dispatched_by IS NOT NULL)";

/** A row of {@link LIVE_RUNS_QUERY}, as either target's read answers it. */
export interface LiveRunRow {
  id?: unknown;
  task?: unknown;
  status?: unknown;
  started_at?: unknown;
  queued_at?: unknown;
  run_context?: unknown;
}

/** The budget a run's context names, or null when the context holds none the harness would honour. */
function runContextTimeout(runContext: unknown): number | null {
  if (typeof runContext !== 'string' || runContext === '') return null;
  try {
    const parsed = JSON.parse(runContext) as { timeoutSeconds?: unknown };
    return typeof parsed.timeoutSeconds === 'number' && parsed.timeoutSeconds > 0 ? parsed.timeoutSeconds : null;
  } catch {
    return null;
  }
}

/** The runs the answered rows name, skipping a row that names no run. */
export function liveRunsIn(rows: readonly LiveRunRow[]): LiveRun[] {
  const runs: LiveRun[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'string') continue;
    runs.push({
      id: row.id,
      task: typeof row.task === 'string' && row.task !== '' ? row.task : 'a run without a task',
      status: row.status === 'pending' || row.status === 'queued' ? row.status : 'running',
      startedAt: typeof row.started_at === 'number' ? row.started_at : null,
      queuedAt: typeof row.queued_at === 'number' ? row.queued_at : null,
      timeoutSeconds: runContextTimeout(row.run_context),
    });
  }
  return runs;
}

/** Raised when the Deployment's runs cannot be read; a deploy that cannot see them must not read that as an empty Deployment. */
export class LiveRunsUnreadable extends Error {
  constructor(readonly answer: string) {
    super(
      "the Deployment's runs could not be read; pass --no-drain to ship over whatever is running"
      + (answer === '' ? '' : `. The read answered: ${answer}`),
    );
    this.name = 'LiveRunsUnreadable';
  }
}

/** How long the live-runs read waits before it asks a second time. */
export const LIVE_RUNS_RETRY_MS = 3_000;

/** How often the wait asks the Deployment what is still running. */
export const LIVE_RUN_POLL_MS = 15_000;

/**
 * How long a run may outlive its own bound before the Deployment gives up on
 * it. Mirrors `RUN_OVERRUN_MARGIN_MS` in
 * `packages/myco-server/src/core/harness.ts`; this package ships to operator
 * machines and imports nothing from the server, so the number is copied and
 * held equal by `tests/server/cloudflare-lifecycle.test.ts`.
 */
export const RUN_OVERRUN_MARGIN_MS = 120_000;

/**
 * The budget a run carries when its context names none. Mirrors
 * `DEFAULT_DISPATCH_TIMEOUT_SECONDS` in
 * `packages/myco-server/src/core/harness.ts`, held equal by the same test.
 */
export const DEFAULT_RUN_TIMEOUT_SECONDS = 300;

/** How the wait and the watch spend time; a test drives both without spending any. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
};

/**
 * One read of a Deployment's runs, asked twice.
 *
 * A command that fails, one that answers nothing inside its window, and an
 * answer carrying no readable document all refuse the read: "nothing came
 * back" and "nothing is running" are opposite facts, and a deploy that confused
 * them would ship straight over live work.
 * Either answer is asked again once after a pause first — a transient failure
 * refused on the spot costs the operator the whole run. Only a second bad
 * answer raises, carrying what the command itself said.
 */
export async function readLiveRunsTwice(options: {
  /** Runs the read, answering its raw output, and throwing what the command said. */
  ask(): Promise<string>;
  /** Reads the rows out of that output, or null when it carries no readable document. */
  rowsIn(output: string): LiveRunRow[] | null;
  sleep?: (ms: number) => Promise<void>;
}): Promise<LiveRun[]> {
  const sleep = options.sleep ?? systemClock.sleep;
  let answer = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(LIVE_RUNS_RETRY_MS);
    let output: string;
    try {
      output = await options.ask();
    } catch (err) {
      if (!isCommandFailure(err)) throw err;
      answer = err.message;
      continue;
    }
    const rows = options.rowsIn(output);
    if (rows === null) {
      answer = commandOutputTail(output) || output.trim();
      continue;
    }
    return liveRunsIn(rows);
  }
  throw new LiveRunsUnreadable(answer);
}

/** A duration in the words an operator waiting on it would use. */
function describeDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} sec`;
  return `${Math.round(seconds / 60)} min`;
}

/** The budget a run gets: its own, or the dispatcher's default for a run that names none. */
function budgetSeconds(run: LiveRun): number {
  return run.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS;
}

/**
 * When the Deployment stops treating a run as its own: its budget plus the
 * overrun margin, counted from when its launch went out. A `queued` row reaches
 * this wait only after a launch, and keeps that launch's start and budget, so
 * it is bounded exactly as a running one is. A row this read answers without a
 * start is one no launch was written for, and it is counted from now.
 */
function runDeadline(run: LiveRun, now: number): number {
  return (run.startedAt ?? now) + budgetSeconds(run) * 1000 + RUN_OVERRUN_MARGIN_MS;
}

/**
 * One run, named the way an operator watching a deploy would name it.
 *
 * A `pending` row is a run the dispatcher has already admitted and is about to
 * launch. A `queued` row reaches here only with a runtime already working
 * under it; one held behind a limit and never dispatched waits for the next
 * wake, and no deploy waits for it.
 */
function describeRun(lead: string, run: LiveRun, now: number): string {
  const kind = run.status === 'pending'
    ? 'task about to start'
    : run.status === 'queued'
      ? 'task the queue took back while its runtime kept working'
      : 'running task';
  const when = run.startedAt !== null
    ? `started ${describeDuration(now - run.startedAt)} ago`
    : 'not started yet';
  return `${lead} a ${kind}: ${run.task}, ${when}, budget ${describeDuration(budgetSeconds(run) * 1000)}`;
}

export interface WaitOptions {
  /** What is in flight now, asked again on every poll. */
  read(): Promise<LiveRun[]>;
  /**
   * What carries a run the wait stopped waiting on, in the target's own words:
   * the sentence completing "…; <this>." Both places it is said are moments
   * the deploy proceeds over a run it did not see end.
   */
  sparing: string;
  /** Whether the deploy waits for the runs in flight before it ships; `--no-drain` turns it off. */
  drain?: boolean;
  /** Where the wait says where it is, as it gets there. */
  report?: (line: string) => void;
  clock?: Clock;
}

/**
 * Wait for the runs in flight to end before the deploy replaces what carries
 * them.
 *
 * Each run read at the first look carries its own bound: its budget plus the
 * margin the Deployment allows it. Past the last of those bounds the run has
 * outlived what anyone promised it, so the deploy goes ahead and the stale
 * sweep owns the row; a run dispatched while the wait was running was never
 * one of the runs waited on, and is named as such.
 */
export async function waitForLiveRuns(options: WaitOptions): Promise<void> {
  const report = options.report ?? console.log;
  const clock = options.clock ?? systemClock;

  if (options.drain === false) {
    // The read is a courtesy here rather than a gate: --no-drain is the escape
    // hatch, and a Deployment that cannot be read is exactly when it is used.
    try {
      const live = await options.read();
      const now = clock.now();
      for (const run of live) report(describeRun('Shipping over', run, now));
    } catch (err) {
      report(`What is running could not be read (${describeFailure(err)}).`);
    }
    report(`Not waiting for the runs in flight: ${options.sparing}.`);
    return;
  }

  let live = await options.read();
  if (live.length === 0) return;
  const first = clock.now();
  for (const run of live) report(describeRun('Waiting for', run, first));
  const bounds = new Map(live.map((run) => [run.id, runDeadline(run, first)]));
  const deadline = Math.max(...bounds.values());

  while (live.length > 0) {
    if (clock.now() >= deadline) {
      const overdue = live.filter((run) => bounds.has(run.id));
      const fresh = live.filter((run) => !bounds.has(run.id));
      // Which part of the Deployment owns a row past its bound depends on the
      // row: the stale sweep reads the two live statuses, and a row the queue
      // took back is left to the expiry that clears the queue.
      const swept = overdue.filter((run) => run.status !== 'queued');
      const expiring = overdue.filter((run) => run.status === 'queued');
      if (swept.length > 0) {
        report(`A task outlived its own budget (${swept.map((run) => run.task).join(', ')}); the deploy proceeds and the stale sweep owns the run.`);
      }
      if (expiring.length > 0) {
        report(`A task the queue took back outlived its own budget (${expiring.map((run) => run.task).join(', ')}); the deploy proceeds and the queue's expiry owns the row.`);
      }
      if (fresh.length > 0) {
        report(`${fresh.map((run) => run.task).join(', ')} started during the deploy; ${options.sparing}.`);
      }
      return;
    }
    await clock.sleep(LIVE_RUN_POLL_MS);
    live = await options.read();
  }
  report('Nothing is running; the deploy proceeds.');
}
