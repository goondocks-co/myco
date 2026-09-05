/**
 * What each scheduled job does when the tick runs it.
 *
 * `jobs.ts` declares the jobs and the depth each runs at; this is the work.
 * Every implementation converges on the state its declaration names and is
 * safe to run again the next second: a second delivery of one wake finds
 * nothing left to do.
 */
import type { ServerEnv } from './adapters.js';
import { DEFAULT_DISPATCH_TIMEOUT_SECONDS, endQueuedRun, HARNESS_MEMBER_ID, RUN_OVERRUN_MARGIN_MS } from './harness.js';
import { emit } from '../telemetry.js';
import { failStaleRun, listLiveRunsAcrossProjects, listQueuedAcrossProjects, pruneRevokedCredentials, pruneTerminalRuns } from './runs.js';
import { leafValues } from './settings.js';
import { releaseRun } from './release.js';

/** The retention window when the leaf is unset, and the bounds the leaf itself declares. */
export const RUN_RETENTION_DAYS_DEFAULT = 30;
const RUN_RETENTION_DAYS_MIN = 1;
const RUN_RETENTION_DAYS_MAX = 365;
const DAY_MS = 86_400_000;

/** How many rows one pass of a job touches before it yields; the next tick continues. */
export const JOB_BATCH = 500;

/** A job answers how many rows it changed; the tick reports that per job. */
export type JobRun = (env: ServerEnv, now: number) => Promise<number>;

/** The retention window in days from the Deployment's leaf, clamped to the leaf's bounds; unset means the default. */
export async function runRetentionDays(env: ServerEnv): Promise<number> {
  const raw = (await leafValues(env.db, ['agent.run_retention_days'])).get('agent.run_retention_days');
  if (raw === undefined) return RUN_RETENTION_DAYS_DEFAULT;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return RUN_RETENTION_DAYS_DEFAULT; }
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return RUN_RETENTION_DAYS_DEFAULT;
  return Math.min(RUN_RETENTION_DAYS_MAX, Math.max(RUN_RETENTION_DAYS_MIN, Math.floor(parsed)));
}

/**
 * No terminal, non-resumable run outlives the retention window; its turns and
 * reports go with it, and so do the dispatch credentials no surviving run names.
 *
 * The credentials are pruned in the same pass and against the same window: one
 * is minted per run and revoked when that run closes, so the table grows once
 * per run the Deployment has ever made.
 */
export async function agentRunRetention(env: ServerEnv, now: number): Promise<number> {
  const cutoff = now - (await runRetentionDays(env)) * DAY_MS;
  const runs = await pruneTerminalRuns(env.db, cutoff, JOB_BATCH);
  return runs + await pruneRevokedCredentials(env.db, HARNESS_MEMBER_ID, cutoff, JOB_BATCH);
}

/** The bound a dispatched run carries in its context, or the dispatcher's default when it carries none. */
export function timeoutSecondsOf(runContext: string | null): number {
  if (runContext === null) return DEFAULT_DISPATCH_TIMEOUT_SECONDS;
  try {
    const parsed: unknown = JSON.parse(runContext);
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as { timeoutSeconds?: unknown }).timeoutSeconds : undefined;
    return typeof value === 'number' && value > 0 ? value : DEFAULT_DISPATCH_TIMEOUT_SECONDS;
  } catch {
    return DEFAULT_DISPATCH_TIMEOUT_SECONDS;
  }
}

/** The instant past which a live run's runtime is taken to have gone away: its own bound, plus the margin the container hold allows past it. */
export function staleAfter(startedAt: number, runContext: string | null): number {
  return startedAt + timeoutSecondsOf(runContext) * 1000 + RUN_OVERRUN_MARGIN_MS;
}

export const STALE_RUN_ERROR = 'the runtime went away';

/**
 * How long a dispatch may wait in the queue before the Deployment gives up on it.
 *
 * A queued run waits for capacity. Capacity that never returns — a harness that
 * is gone rather than busy — ends here: the row is failed by name and the
 * reader is told. `QUEUE_EXPIRED_ERROR` names this bound in words, and a test
 * holds the two in step.
 */
export const QUEUE_MAX_AGE_MS = DAY_MS;
export const QUEUE_EXPIRED_ERROR = 'no runtime took the run within a day';

/**
 * No run stays waiting past its bound.
 *
 * A live run whose runtime went away is failed by name and released as a
 * finished run is. A queued run nothing launched within `QUEUE_MAX_AGE_MS` is
 * ended through the queue's own release, which retires what its row still
 * holds.
 */
export async function runStaleSweep(env: ServerEnv, now: number): Promise<number> {
  let changed = 0;
  for (const run of await listLiveRunsAcrossProjects(env.db, JOB_BATCH)) {
    if (run.startedAt === null || now < staleAfter(run.startedAt, run.runContext)) continue;
    const scope = { projectId: run.projectId };
    if (!(await failStaleRun(env.db, scope, run.id, now, STALE_RUN_ERROR))) continue;
    await releaseRun(env, scope, run, now, { drain: false });
    changed += 1;
  }
  for (const queued of await listQueuedAcrossProjects(env.db, JOB_BATCH)) {
    if (now - queued.queuedAt < QUEUE_MAX_AGE_MS) continue;
    if (!(await endQueuedRun(env, { projectId: queued.projectId }, queued, now, { failed: QUEUE_EXPIRED_ERROR }))) continue;
    emit({ kind: 'harness_queue_expired', runId: queued.id, task: queued.task, projectId: queued.projectId });
    changed += 1;
  }
  return changed;
}

/** Every declared job's implementation, by name. A declared job absent here is refused by a gate, never skipped in silence. */
export const JOB_IMPLEMENTATIONS: Readonly<Record<string, JobRun>> = {
  'agent-run-retention': agentRunRetention,
  'run-stale-sweep': runStaleSweep,
};
