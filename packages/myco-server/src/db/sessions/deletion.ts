import type { ErrorClassifier, RelationalStore } from '../../core/adapters.js';
import type { BlobRef } from '../../core/blob-references.js';
import { assertion, commitNamed, first, read, readSet, refusalCode, refused, rows, write } from '../index.js';
import { RELEASE_PAGE, HOLD_OPEN, decideRecordedBlobs } from '../storage/release-queue.js';
import { DELETION_PAGE, DELETION_PHASES, PLANS_PHASE, RESERVATION_CUTOFF, REMAINING_TABLES, remainingTerm, type DeletionPhase, type RecordedCandidate } from './deletion-phases.js';
import { sessionFactsCleared, sessionPresent } from './tombstones.js';
import { classify, emit } from '../../telemetry.js';

/** Why a deletion job waits: a recovery hold keeps every row and object as it stands, and a restore owns the document it is rewriting. */
type DeletionPause = 'recovery_hold' | 'restore';

export interface DeletionProgress {
  state: 'running' | 'complete';
  /** The cleanup step in progress, by the table it empties; the job finished when `state` is `complete`. */
  phase: string;
  phasesDone: number;
  phasesTotal: number;
  /** Rows the job removed so far. Cleanup of stored objects continues in the object release drain. */
  removed: number;
  blobsReleased: number;
  acceptedAt: number;
  updatedAt: number;
  completedAt: number | null;
  pausedBy: DeletionPause | null;
  /** The class of the error the latest step ended on, until a step succeeds. */
  failure: { errorClass: string; failedAt: number } | null;
}

const FINAL_PHASE = 'verify';
const PHASE_ORDER = [...DELETION_PHASES.map(phase => phase.name), FINAL_PHASE] as const;
const NEXT_PHASE = new Map(PHASE_ORDER.map((name, index) => [name, PHASE_ORDER[index + 1] ?? FINAL_PHASE]));
const firstPhase = PHASE_ORDER[0]!;
const phaseIndex = (name: string): number => Math.max(PHASE_ORDER.indexOf(name), 0);

const paused = refusalCode('session_deletion_paused');
const moved = refusalCode('session_deletion_moved');

const RESTORING = `EXISTS(SELECT 1 FROM session_documents d WHERE d.project_id=?1 AND d.session_id=?2 AND d.restore_hold IS NOT NULL AND (d.due_at IS NULL OR d.due_at>?3))`;
const proceeds = assertion<[project: string, session: string, now: number]>({ name: 'deletion.proceeds', refusal: paused, when: `NOT ${HOLD_OPEN} AND NOT ${RESTORING}` });
const unchanged = assertion<[project: string, session: string, revision: number]>({ name: 'deletion.jobUnchanged', refusal: moved,
  when: "EXISTS(SELECT 1 FROM session_deletion_jobs WHERE project_id=?1 AND session_id=?2 AND revision=?3 AND state='running')" });

const insertTombstone = write<[project: string, session: string, reason: string | null, at: number, by: string], { session_id: string }>({ name: 'deletion.tombstone', sql:
  `INSERT INTO session_tombstones(project_id,session_id,reason,created_at,created_by)
    SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM sessions WHERE project_id=?1 AND session_id=?2)
    ON CONFLICT(project_id,session_id) DO NOTHING RETURNING session_id` });
const insertJob = write<[project: string, session: string, phase: string, at: number]>({ name: 'deletion.acceptJob', sql:
  `INSERT INTO session_deletion_jobs(project_id,session_id,phase,accepted_at,updated_at)
    SELECT ?1,?2,?3,?4,?4 WHERE EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=?1 AND session_id=?2)
    ON CONFLICT(project_id,session_id) DO NOTHING` });
const maskServedItems = write<[project: string, session: string]>({ name: 'deletion.maskServedItems', sql:
  'UPDATE injection_served_items SET title=NULL,content_hash=NULL,session_id=NULL,unavailable=1 WHERE project_id=?1 AND session_id=?2' });
const removePendingCards = write<[project: string, session: string]>({ name: 'deletion.removePendingCards', sql:
  "DELETE FROM turn_cards WHERE project_id=?1 AND session_id=?2 AND state='pending'" });
const removeLearning = write<[project: string, session: string]>({ name: 'deletion.removeLearning', sql:
  'DELETE FROM learning_sessions WHERE project_id=?1 AND session_id=?2' });
const removeDocument = write<[project: string, session: string, now: number]>({ name: 'deletion.removeDocument', sql:
  'DELETE FROM session_documents WHERE project_id=?1 AND session_id=?2 AND NOT (restore_hold IS NOT NULL AND (due_at IS NULL OR due_at>?3))' });

interface StatusRow {
  state: 'running' | 'complete'; phase: string; removed: number; blobs_released: number; accepted_at: number; updated_at: number; completed_at: number | null;
  failure: string | null; failed_at: number | null; held: number; restoring: number;
}
const COLUMNS = `state,phase,removed,blobs_released,accepted_at,updated_at,completed_at,failure,failed_at,${HOLD_OPEN} AS held,${RESTORING} AS restoring`;
const statusRead = read<[project: string, session: string, now: number], StatusRow>({ name: 'deletion.status', sql:
  `SELECT ${COLUMNS} FROM session_deletion_jobs WHERE project_id=?1 AND session_id=?2` });

const progressOf = (row: StatusRow): DeletionProgress => ({
  state: row.state,
  phase: row.state === 'complete' ? 'complete' : row.phase,
  phasesDone: row.state === 'complete' ? PHASE_ORDER.length : phaseIndex(row.phase),
  phasesTotal: PHASE_ORDER.length,
  removed: row.removed,
  blobsReleased: row.blobs_released,
  acceptedAt: row.accepted_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  pausedBy: row.state === 'complete' ? null : row.held === 1 ? 'recovery_hold' : row.restoring === 1 ? 'restore' : null,
  failure: row.failure === null ? null : { errorClass: row.failure, failedAt: row.failed_at ?? 0 },
});

/** One page of a phase's rows, bound for the commit that removes them: the keys read here, every other value re-read from the live rows inside the commit. */
function pageStatements(phase: DeletionPhase, page: readonly Record<string, string | number>[], session: string, now: number) {
  const keys = JSON.stringify(page.map(row => Object.values(row)));
  return phase.statements(keys, session, RESERVATION_CUTOFF(now), now);
}

const CANDIDATES = (recorded: readonly (readonly RecordedCandidate[])[]): BlobRef[] => {
  const seen = new Map<string, BlobRef>();
  for (const row of recorded.flat()) seen.set(JSON.stringify([row.project_id, row.key]), { projectId: row.project_id, key: row.key });
  return [...seen.values()];
};

export interface DeletionAccept { projectId: string; sessionId: string; by: string; reason?: string; now: number }

/**
 * Accepts a session's deletion, in one commit: the tombstone that hides it from every read and refuses further capture,
 * the facts it says of itself, its snapshots in other sessions' receipts, the rows project-wide reads show, and the job that owns the
 * rest. Answers the job as it stands, or null when the Project holds no such session.
 */
export async function acceptSessionDeletion(db: RelationalStore, accept: DeletionAccept): Promise<DeletionProgress | null> {
  const { projectId, sessionId, by, reason, now } = accept;
  if (!await sessionPresent(db, projectId, sessionId)) return null;
  const [plans] = await readSet(db, PLANS_PHASE.page.bind(projectId, sessionId, DELETION_PAGE));
  const planPage = pageStatements(PLANS_PHASE, plans, sessionId, now);
  const { status, recorded } = await commitNamed(db, {
    tombstone: insertTombstone.bind(projectId, sessionId, reason ?? null, now, by),
    job: insertJob.bind(projectId, sessionId, firstPhase, now),
    facts: sessionFactsCleared(projectId, sessionId),
    served: maskServedItems.bind(projectId, sessionId),
    planTags: planPage.before,
    recorded: planPage.recorded,
    plans: planPage.removed,
    cards: removePendingCards.bind(projectId, sessionId),
    learning: removeLearning.bind(projectId, sessionId),
    document: removeDocument.bind(projectId, sessionId, now),
    status: statusRead.bind(projectId, sessionId, now),
  });
  const row = status.results[0];
  if (row === undefined) return null;
  const candidates = CANDIDATES(recorded.map(result => result.results));
  if (candidates.length > 0) await decideCandidates(db, candidates, now);
  return progressOf(row);
}

const deletionTombstoned = read<[project: string, session: string], { present: number }>({ name: 'deletion.tombstoned', sql:
  'SELECT 1 AS present FROM session_tombstones WHERE project_id=?1 AND session_id=?2' });

/** A deletion job's progress, or null when the Project never deleted this session. A session deleted before jobs existed answers complete, with nothing counted. */
export async function deletionProgress(db: RelationalStore, projectId: string, sessionId: string, now: number): Promise<DeletionProgress | null> {
  const [row] = await rows(db, statusRead.bind(projectId, sessionId, now));
  if (row !== undefined) return progressOf(row);
  const [tombstone] = await rows(db, deletionTombstoned.bind(projectId, sessionId));
  if (tombstone === undefined) return null;
  return { state: 'complete', phase: 'complete', phasesDone: PHASE_ORDER.length, phasesTotal: PHASE_ORDER.length, removed: 0, blobsReleased: 0, acceptedAt: 0, updatedAt: 0, completedAt: 0, pausedBy: null, failure: null };
}

async function decideCandidates(db: RelationalStore, candidates: readonly BlobRef[], now: number): Promise<number> {
  let released = 0;
  for (let at = 0; at < candidates.length; at += RELEASE_PAGE) released += (await decideRecordedBlobs(db, candidates.slice(at, at + RELEASE_PAGE), now)).released;
  return released;
}

interface HeldJob { project_id: string; session_id: string; phase: string; revision: number; held: number; restoring: number }
const runningJobs = read<[limit: number, now: number], HeldJob>({ name: 'deletion.runningJobs', sql:
  `SELECT j.project_id,j.session_id,j.phase,j.revision,${HOLD_OPEN} AS held,
      EXISTS(SELECT 1 FROM session_documents d WHERE d.project_id=j.project_id AND d.session_id=j.session_id AND d.restore_hold IS NOT NULL AND (d.due_at IS NULL OR d.due_at>?2)) AS restoring
    FROM session_deletion_jobs j INDEXED BY idx_session_deletion_jobs_running WHERE j.state='running' ORDER BY j.failed_at IS NOT NULL,j.accepted_at,j.project_id,j.session_id LIMIT ?1` });

const advance = write<[phase: string, removed: number, at: number, project: string, session: string, revision: number]>({ name: 'deletion.advance', sql:
  'UPDATE session_deletion_jobs SET phase=?1,removed=removed+?2,updated_at=?3,failure=NULL,failed_at=NULL,revision=revision+1 WHERE project_id=?4 AND session_id=?5 AND revision=?6' });
const creditBlobs = write<[released: number, project: string, session: string]>({ name: 'deletion.creditBlobs', sql:
  'UPDATE session_deletion_jobs SET blobs_released=blobs_released+?1 WHERE project_id=?2 AND session_id=?3' });
const restartPhases = write<[phase: string, at: number, project: string, session: string, revision: number]>({ name: 'deletion.restartPhases', sql:
  "UPDATE session_deletion_jobs SET phase=?1,updated_at=?2,failure=NULL,failed_at=NULL,revision=revision+1 WHERE project_id=?3 AND session_id=?4 AND revision=?5 AND state='running'" });
const finish = write<[at: number, project: string, session: string, revision: number], { finished: number }>({ name: 'deletion.finish', sql:
  `UPDATE session_deletion_jobs SET state='complete',phase='complete',completed_at=?1,updated_at=?1,failure=NULL,failed_at=NULL,revision=revision+1
    WHERE project_id=?2 AND session_id=?3 AND revision=?4 AND state='running' AND NOT (${REMAINING_TABLES.map(table => remainingTerm(table, '?2', '?3')).join(' OR ')})
    RETURNING 1 AS finished` });

const recordFailure = write<[failure: string, at: number, project: string, session: string]>({ name: 'deletion.recordFailure', sql:
  "UPDATE session_deletion_jobs SET failure=?1,failed_at=?2 WHERE project_id=?3 AND session_id=?4 AND state='running'" });

/** Empty tables one step reads past before it commits how far it got. */
const EMPTY_PHASES_PER_STEP = 8;
/** Deletion steps one wake runs, across every job it takes. */
const DELETION_STEPS_PER_WAKE = 8;
/** Jobs one wake can reach before it returns to the oldest. */
const JOBS_PER_WAKE = 8;

interface StepOutcome { removed: number; released: number; pausedBy: DeletionPause | null; state: 'running' | 'complete'; phase: string; revision: number }

/**
 * Takes one bounded step of a deletion job. Every statement that deletes runs under the hold and revision checks, in
 * one commit with the job's own advance; a step that loses its revision or finds a hold changes nothing.
 */
async function stepDeletion(db: RelationalStore, job: HeldJob, now: number): Promise<StepOutcome> {
  const { project_id: project, session_id: session, phase: phaseName, revision } = job;
  const still = (next: string): StepOutcome => ({ removed: 0, released: 0, pausedBy: null, state: 'running', phase: next, revision: revision + 1 });
  if (job.held === 1 || job.restoring === 1) return { ...still(phaseName), revision, pausedBy: job.held === 1 ? 'recovery_hold' : 'restore' };

  if (phaseName === FINAL_PHASE) {
    const finished = await first(db, finish.bind(now, project, session, revision));
    if (finished !== null) return { ...still(phaseName), state: 'complete' };
    // A row remains: a writer the tombstone did not stop, or a restore that added one. The phases run again, and they are idempotent.
    await rows(db, restartPhases.bind(firstPhase, now, project, session, revision));
    return still(firstPhase);
  }

  // Empty tables are skipped by reading, so a session that never touched a table spends one read on it and no commit.
  let cursor = phaseIndex(phaseName);
  let phase = DELETION_PHASES[cursor];
  let page: readonly Record<string, string | number>[] = [];
  for (let scanned = 0; phase !== undefined && scanned < EMPTY_PHASES_PER_STEP; scanned += 1) {
    [page] = await readSet(db, phase.page.bind(project, session, DELETION_PAGE));
    if (page.length > 0) break;
    cursor += 1;
    phase = DELETION_PHASES[cursor];
  }
  const next = phase === undefined ? FINAL_PHASE
    : page.length === 0 ? phase.name
    : page.length === DELETION_PAGE ? phase.name : DELETION_PHASES[cursor + 1]?.name ?? FINAL_PHASE;
  const statements = page.length === 0 || phase === undefined ? null : pageStatements(phase, page, session, now);
  try {
    const { recorded } = await commitNamed(db, {
      proceeds: proceeds.bind(project, session, now),
      unchanged: unchanged.bind(project, session, revision),
      before: statements?.before ?? [],
      recorded: statements?.recorded ?? [],
      removed: statements === null ? [] : [statements.removed],
      advance: advance.bind(next, page.length, now, project, session, revision),
    });
    const candidates = CANDIDATES(recorded.map(result => result.results));
    const released = candidates.length === 0 ? 0 : await decideCandidates(db, candidates, now);
    if (released > 0) await rows(db, creditBlobs.bind(released, project, session));
    return { ...still(next), removed: page.length, released };
  } catch (error) {
    if (refused(error, paused)) return { ...still(phaseName), revision, pausedBy: 'recovery_hold' };
    if (refused(error, moved)) return { ...still(phaseName), revision };
    throw error;
  }
}

/** Names a step's failure on its job and in telemetry, so the job behind it still runs. The job keeps its place and is taken again next wake. */
async function noteStepFailure(db: RelationalStore, job: HeldJob, error: unknown, now: number, classifier?: ErrorClassifier): Promise<void> {
  const errorClass = classify(error, classifier);
  emit({ kind: 'session_deletion_step_failed', projectId: job.project_id, sessionId: job.session_id, phase: job.phase, error_class: errorClass });
  try { await rows(db, recordFailure.bind(errorClass, now, job.project_id, job.session_id)); } catch { /* the telemetry above already names it */ }
}

/**
 * Advances running deletion jobs by bounded steps, the oldest first. The tombstone commits at acceptance, before any of this;
 * a job paused by a hold changes nothing and is judged again next wake. Answers rows removed, whether a wake right
 * after this one has work, and how many steps failed.
 */
export async function advanceSessionDeletions(db: RelationalStore, now: number, stepBudget = DELETION_STEPS_PER_WAKE, classifier?: ErrorClassifier): Promise<{ changed: number; more: boolean; failed: number }> {
  const jobs = await rows(db, runningJobs.bind(JOBS_PER_WAKE, now));
  let steps = stepBudget;
  let changed = 0;
  let failed = 0;
  let working = jobs;
  while (working.length > 0 && steps > 0) {
    const carried: HeldJob[] = [];
    for (const job of working) {
      if (steps === 0) { carried.push(job); continue; }
      steps -= 1;
      let step: StepOutcome;
      try {
        step = await stepDeletion(db, job, now);
      } catch (error) {
        await noteStepFailure(db, job, error, now, classifier);
        failed += 1;
        continue;
      }
      changed += step.removed + step.released;
      if (step.state === 'running' && step.pausedBy === null) carried.push({ ...job, phase: step.phase, revision: step.revision });
    }
    working = carried;
  }
  return { changed, more: working.length > 0, failed };
}

