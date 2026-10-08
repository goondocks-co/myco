/**
 * A run's attempts, and the step log each attempt's worker observed.
 *
 * A claim records its attempt in the batch that claims the run (`claimQueuedRun`), naming the run credential it
 * minted and who took it: a legacy worker's member credential and machine, or a runner and the runner credential that
 * claimed. The attempt is what a step page is filed under: a worker sends the log of the attempt it drove, with that
 * attempt's id, and the Deployment stores it there and nowhere else. A legacy worker's page is accepted from the
 * credential that claimed the attempt, or from another member credential of the same machine. A runner's page is
 * accepted from that runner alone, whichever of its current credentials presents it, and never on a machine match.
 *
 * Storing a page writes the attempt's step rows and its totals and nothing else: no run status, error, cost or usage
 * moves, so a log that arrives after its run ended, or after another attempt took the run, changes no outcome. Every
 * write is idempotent: a step is keyed by its attempt and sequence number and lands once, and an attempt's totals are
 * set by the first page that carries them.
 */
import type { PreparedStatement, RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import type { StepPage } from '@goondocks/myco-shared/worker-steps';
import type { WorkerPrincipal } from './worker-lease.js';

/** The statement that records one claim's attempt; it lands only where the run names that attempt as running under this owner. */
export function recordAttemptStatement(
  db: RelationalStore, scope: ReadScope, runId: string, attemptId: string, worker: WorkerPrincipal, now: number,
): PreparedStatement {
  const runner = worker.kind === 'runner';
  return db.prepare(
    `INSERT INTO agent_run_attempts (project_id, run_id, attempt_id, leased_by, machine_id, claimed_at, owner_kind, runner_id)
     SELECT project_id, id, dispatched_by, ?, ?, ?, ?, ? FROM agent_runs
      WHERE project_id = ? AND id = ? AND status = 'running' AND dispatched_by = ?
        AND ${runner ? 'leased_runner_id = ? AND leased_runner_credential_id = ?' : 'leased_by = ?'}
     ON CONFLICT (project_id, run_id, attempt_id) DO NOTHING`,
  ).bind(runner ? worker.credentialId : worker.tokenId, worker.machineId, now, worker.kind, runner ? worker.runnerId : null,
    scope.projectId, runId, attemptId, ...(runner ? [worker.runnerId, worker.credentialId] : [worker.tokenId]));
}

/** What storing a page answered: how many of its steps were new, or why the page is refused. */
export type StepPageOutcome = { stored: true; landed: number } | { stored: false; reason: string };

/** What a page naming an attempt this Deployment does not hold, or holds for another worker, is answered. */
export const STEP_ATTEMPT_UNHELD = 'no attempt of that run belongs to this worker';

/** Store one page of an attempt's step log. */
export async function storeStepPage(
  db: RelationalStore, scope: ReadScope, runId: string, page: StepPage, worker: WorkerPrincipal, now: number,
): Promise<StepPageOutcome> {
  const attempt = await db.prepare(
    `SELECT leased_by AS leasedBy, machine_id AS machineId, owner_kind AS ownerKind, runner_id AS runnerId
       FROM agent_run_attempts WHERE project_id = ? AND run_id = ? AND attempt_id = ?`,
  ).bind(scope.projectId, runId, page.attemptId).first<{ leasedBy: string; machineId: string | null; ownerKind: 'member' | 'runner'; runnerId: string | null }>();
  if (attempt === null || !attemptOwnedBy(attempt, worker)) return { stored: false, reason: STEP_ATTEMPT_UNHELD };
  const key = [scope.projectId, runId, page.attemptId] as const;
  const totals = db.prepare(
    `UPDATE agent_run_attempts SET steps_total = COALESCE(steps_total, ?), steps_overflow = COALESCE(steps_overflow, ?), unrecognized = COALESCE(unrecognized, ?)
      WHERE project_id = ? AND run_id = ? AND attempt_id = ?`,
  ).bind(page.total, page.overflow, JSON.stringify(page.unrecognized), ...key);
  // One statement for the page's steps, its rows read from one bound value: a page holds up to `STEPS_PER_PAGE`
  // steps, and the hosted store counts each statement of a batch against its per-invocation query limit and allows a
  // hundred bound values in one.
  const rows = JSON.stringify(page.steps.map((step) => [step.seq, step.callId, step.kind, step.tool, step.target, step.outcome, step.exitCode, step.startedAt, step.endedAt]));
  const steps = db.prepare(
    `INSERT INTO agent_run_steps (project_id, run_id, attempt_id, seq, call_id, kind, tool, target, outcome, exit_code, started_at, ended_at, received_at)
     SELECT ?, ?, ?, json_extract(r.value, '$[0]'), json_extract(r.value, '$[1]'), json_extract(r.value, '$[2]'), json_extract(r.value, '$[3]'),
            json_extract(r.value, '$[4]'), json_extract(r.value, '$[5]'), json_extract(r.value, '$[6]'), json_extract(r.value, '$[7]'), json_extract(r.value, '$[8]'), ?
       FROM json_each(?) AS r
      WHERE EXISTS (SELECT 1 FROM agent_run_attempts WHERE project_id = ? AND run_id = ? AND attempt_id = ?)
     ON CONFLICT (project_id, run_id, attempt_id, seq) DO NOTHING`,
  ).bind(...key, now, rows, ...key);
  const results = await db.batch([totals, steps]);
  return { stored: true, landed: results[1]?.meta.changes ?? 0 };
}

/** Whether `worker` owns a recorded attempt: the same runner for a runner's attempt; for a legacy worker's, its claiming credential or its machine. */
export function attemptOwnedBy(attempt: { leasedBy: string; machineId: string | null; ownerKind: 'member' | 'runner'; runnerId: string | null }, worker: WorkerPrincipal): boolean {
  if (attempt.ownerKind === 'runner') return worker.kind === 'runner' && attempt.runnerId === worker.runnerId;
  return worker.kind === 'member' && (attempt.leasedBy === worker.tokenId || (attempt.machineId !== null && attempt.machineId === worker.machineId));
}

/** Whether a worker's claim of this run recorded its attempt: the cutoff at which a run's report owes its audit. */
export async function runHasAttempt(db: RelationalStore, scope: ReadScope, runId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS one FROM agent_run_attempts WHERE project_id = ? AND run_id = ? LIMIT 1`)
    .bind(scope.projectId, runId).first<{ one: number }>();
  return row !== null;
}
