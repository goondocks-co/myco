/**
 * A run's attempts, and the step log each attempt's worker observed.
 *
 * A claim records its attempt in the batch that claims the run. The attempt is what a step page is filed under: a
 * worker sends the log of the attempt it drove, with that attempt's id, and the Deployment stores it there and nowhere
 * else. A legacy worker's page is accepted from the credential that claimed the attempt, or from another member
 * credential of the same machine. A runner's page is accepted from that runner alone, whichever of its current
 * credentials presents it, and never on a machine match.
 *
 * Storing a page writes the attempt's step rows, its totals and its received count and nothing else: no run status,
 * error, cost or usage moves, so a log that arrives after its run ended, or after another attempt took the run, changes
 * no outcome. Every write is idempotent: a step is keyed by its attempt and sequence number and lands once, and the
 * received count moves only by the steps that batch adds.
 */
import type { StepPage } from '@goondocks/myco-shared/worker-steps';
import type { RelationalStore } from '../../core/adapters.js';
import type { WorkerPrincipal } from '../../core/worker-lease.js';
import type { ReadScope } from '../../read/scope.js';
import { commit, read, write } from '../index.js';

/** What storing a page answered: how many of its steps were new, or why the page is refused. */
type StepPageOutcome = { stored: true; landed: number } | { stored: false; reason: string };

/** What a page naming an attempt this Deployment does not hold, or holds for another worker, is answered. */
export const STEP_ATTEMPT_UNHELD = 'no attempt of that run belongs to this worker';

interface AttemptOwner { leasedBy: string; machineId: string | null; ownerKind: 'member' | 'runner'; runnerId: string | null }
const attemptOwnerRead = read<[string, string, string], AttemptOwner>({ name: 'runs.attemptOwner', sql:
  `SELECT leased_by AS leasedBy, machine_id AS machineId, owner_kind AS ownerKind, runner_id AS runnerId
     FROM agent_run_attempts WHERE project_id = ? AND run_id = ? AND attempt_id = ?` });
const attemptTotals = write<[number, number, string, string, string, string]>({ name: 'runs.attemptStepTotals', sql:
  `UPDATE agent_run_attempts SET steps_total = COALESCE(steps_total, ?), steps_overflow = COALESCE(steps_overflow, ?), unrecognized = COALESCE(unrecognized, ?)
    WHERE project_id = ? AND run_id = ? AND attempt_id = ?` });
const stepRows = `json_each(?4) AS r WHERE EXISTS (SELECT 1 FROM agent_run_attempts WHERE project_id = ?1 AND run_id = ?2 AND attempt_id = ?3)`;
/** The received count moves by the distinct new steps in this page, before they land, in the batch that adds them. */
const attemptReceived = write<[string, string, string, string]>({ name: 'runs.attemptStepsReceived', sql:
  `INSERT INTO attempt_head (project_id, run_id, attempt_id, received)
   SELECT ?1, ?2, ?3, COUNT(DISTINCT json_extract(r.value, '$[0]')) FROM ${stepRows}
     AND NOT EXISTS (SELECT 1 FROM agent_run_steps s WHERE s.project_id = ?1 AND s.run_id = ?2 AND s.attempt_id = ?3 AND s.seq = json_extract(r.value, '$[0]'))
   HAVING COUNT(*) > 0
   ON CONFLICT (project_id, run_id, attempt_id) DO UPDATE SET received = attempt_head.received + excluded.received` });
const stepInsert = write<[string, string, string, string, number], { landed: number }>({ name: 'runs.storeSteps', sql:
  `INSERT INTO agent_run_steps (project_id, run_id, attempt_id, seq, call_id, kind, tool, target, outcome, exit_code, started_at, ended_at, received_at)
   SELECT ?1, ?2, ?3, json_extract(r.value, '$[0]'), json_extract(r.value, '$[1]'), json_extract(r.value, '$[2]'), json_extract(r.value, '$[3]'),
          json_extract(r.value, '$[4]'), json_extract(r.value, '$[5]'), json_extract(r.value, '$[6]'), json_extract(r.value, '$[7]'), json_extract(r.value, '$[8]'), ?5
     FROM ${stepRows}
   ON CONFLICT (project_id, run_id, attempt_id, seq) DO NOTHING RETURNING 1 AS landed` });
const attemptExists = read<[string, string], { one: number }>({ name: 'runs.hasAttempt', sql:
  `SELECT 1 AS one FROM agent_run_attempts WHERE project_id = ? AND run_id = ? LIMIT 1` });

/** Store one page of an attempt's step log; its received count moves in the same batch. */
export async function storeStepPage(
  db: RelationalStore, scope: ReadScope, runId: string, page: StepPage, worker: WorkerPrincipal, now: number,
): Promise<StepPageOutcome> {
  const attempt = (await commit(db, attemptOwnerRead.bind(scope.projectId, runId, page.attemptId)))[0].results[0] ?? null;
  if (attempt === null || !attemptOwnedBy(attempt, worker)) return { stored: false, reason: STEP_ATTEMPT_UNHELD };
  // One statement for the page's steps, its rows read from one bound value: a page holds up to `STEPS_PER_PAGE`
  // steps, and the hosted store counts each statement of a batch against its per-invocation query limit and allows a
  // hundred bound values in one.
  const rows = JSON.stringify(page.steps.map((step) => [step.seq, step.callId, step.kind, step.tool, step.target, step.outcome, step.exitCode, step.startedAt, step.endedAt]));
  const [, , stored] = await commit(db,
    attemptTotals.bind(page.total, page.overflow, JSON.stringify(page.unrecognized), scope.projectId, runId, page.attemptId),
    attemptReceived.bind(scope.projectId, runId, page.attemptId, rows),
    stepInsert.bind(scope.projectId, runId, page.attemptId, rows, now));
  return { stored: true, landed: stored.results.length };
}

/** Whether `worker` owns a recorded attempt: the same runner for a runner's attempt; for a legacy worker's, its claiming credential or its machine. */
function attemptOwnedBy(attempt: AttemptOwner, worker: WorkerPrincipal): boolean {
  if (attempt.ownerKind === 'runner') return worker.kind === 'runner' && attempt.runnerId === worker.runnerId;
  return worker.kind === 'member' && (attempt.leasedBy === worker.tokenId || (attempt.machineId !== null && attempt.machineId === worker.machineId));
}

/** Whether a worker's claim of this run recorded its attempt: the cutoff at which a run's report owes its audit. */
export async function runHasAttempt(db: RelationalStore, scope: ReadScope, runId: string): Promise<boolean> {
  return (await commit(db, attemptExists.bind(scope.projectId, runId)))[0].results.length > 0;
}
