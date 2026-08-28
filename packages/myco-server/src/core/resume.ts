/**
 * Whether a failed run may be resumed, and why not.
 *
 * Not "retry a failed run". A failure carries WHICH terminal class it is,
 * Each terminal class implies a different next action, and two of them differ
 * only in whether the checkpoint survives.
 *
 * **`sessionExpired` nulls the checkpoint; `postconditionUnsatisfiable` keeps
 * it.** The first holds a poisoned session id — anything reusing it fails
 * identically — and the second is kept precisely so an operator can inspect
 * what the restored phases produced. A port collapsing these into one terminal
 * class gets one of them wrong, and both mistakes are silent.
 *
 * **The zombie guard is why `sessionExpired` exists at all.** Marking an
 * expired-session run resumable re-enqueues it on the next wake and loops
 * forever; the 1.4 executor records 37 such runs accumulating before the guard
 * existed. Detection needs three conditions TOGETHER: the run is a resume, it
 * holds a prior session reference, and it recorded no turns. Any two without the
 * third describe a different failure.
 *
 * **Two clocks, from the same two columns, answering opposite questions.**
 * Single-flighting a live run reads `COALESCE(resumed_at, started_at)` — the
 * current attempt, and a run resumed a moment ago is not stale. Supersession
 * reads `started_at` alone — the ORIGINAL dispatch, which a resume never
 * re-stamps, and dispatch order is what decides whether newer work already
 * finished. Swapping them is silent in both directions.
 */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';

/** How many times a run may be resumed before it is retired and dispatched fresh. */
export const RESUME_MAX_ATTEMPTS = 3;

export const RESUME_STATUSES = [
  'ready', 'session_expired', 'postcondition_unsatisfiable', 'superseded', 'exhausted',
] as const;
export type ResumeStatus = (typeof RESUME_STATUSES)[number];

/** The four statuses that end a run's resumability. `ready` is the only one that does not. */
export const TERMINAL_RESUME_STATUSES: readonly ResumeStatus[] =
  RESUME_STATUSES.filter((s) => s !== 'ready');

/** What the executor observed when a run failed. */
export interface FailureObservation {
  /** True when this attempt is itself a resume. */
  wasResume: boolean;
  /** True when a checkpoint carried a harness session reference into this attempt. */
  hadPriorSession: boolean;
  /** True when this attempt recorded at least one turn. */
  recordedAnyTurns: boolean;
  /** The harness's own classification of the error, when it offers one. */
  errorClass: 'session-expired' | 'postcondition-unsatisfiable' | 'other';
}

export interface ResumeDecision {
  resumable: boolean;
  status: ResumeStatus;
  /** True when the stored checkpoint must be discarded rather than kept. */
  clearCheckpoints: boolean;
}

/**
 * Classify a failure.
 *
 * The zombie case is checked first: an expired session that also failed a
 * postcondition is still a poisoned session id, and keeping its checkpoint
 * would re-poison the next attempt.
 */
export function classifyFailure(observed: FailureObservation): ResumeDecision {
  const sessionExpired = observed.wasResume
    && observed.hadPriorSession
    && !observed.recordedAnyTurns
    && observed.errorClass === 'session-expired';
  if (sessionExpired) return { resumable: false, status: 'session_expired', clearCheckpoints: true };

  if (observed.errorClass === 'postcondition-unsatisfiable') {
    return { resumable: false, status: 'postcondition_unsatisfiable', clearCheckpoints: false };
  }
  return { resumable: true, status: 'ready', clearCheckpoints: false };
}

export type ResumeAdmission =
  | { admit: true; attempt: number }
  | { admit: false; status: 'superseded' | 'exhausted' };

/**
 * Decide whether a resumable run may be resumed now, and consume a retry.
 *
 * Supersession is asked BEFORE the cap: a run whose work another run already
 * finished should not spend a retry discovering that.
 *
 * The attempt is consumed BEFORE the caller dispatches, so a crash mid-resume
 * still counts against the budget. Incrementing on success instead lets a run
 * that crashes during every resume retry forever — the same unbounded shape the
 * zombie guard closes from the other side.
 */
export async function admitResume(
  db: RelationalStore,
  scope: ReadScope,
  run: { id: string; agentId: string; task: string; dryRun: boolean; startedAt: number | null; resumeAttempts: number },
): Promise<ResumeAdmission> {
  const superseding = await db
    .prepare(`SELECT id FROM agent_runs
       WHERE project_id = ? AND id != ? AND status = 'completed' AND completed_at IS NOT NULL
         AND agent_id = ? AND task = ? AND dry_run = ?
         AND completed_at > ?
       ORDER BY completed_at DESC LIMIT 1`)
    .bind(scope.projectId, run.id, run.agentId, run.task, run.dryRun ? 1 : 0, run.startedAt ?? 0)
    .first<{ id: string }>();
  if (superseding !== null) {
    await retire(db, scope, run.id, 'superseded');
    return { admit: false, status: 'superseded' };
  }

  if (run.resumeAttempts >= RESUME_MAX_ATTEMPTS) {
    await retire(db, scope, run.id, 'exhausted');
    return { admit: false, status: 'exhausted' };
  }

  // One statement, and conditional on the budget: two wakes racing the same run
  // cannot both consume the last attempt.
  const consumed = await db
    .prepare(`UPDATE agent_runs SET resume_attempts = resume_attempts + 1
       WHERE project_id = ? AND id = ? AND resumable = 1 AND resume_attempts < ?`)
    .bind(scope.projectId, run.id, RESUME_MAX_ATTEMPTS).run();
  if (consumed.meta.changes !== 1) return { admit: false, status: 'exhausted' };
  return { admit: true, attempt: run.resumeAttempts + 1 };
}

async function retire(db: RelationalStore, scope: ReadScope, runId: string, status: ResumeStatus): Promise<void> {
  await db.prepare(`UPDATE agent_runs SET resumable = 0, resume_status = ? WHERE project_id = ? AND id = ?`)
    .bind(status, scope.projectId, runId).run();
}
