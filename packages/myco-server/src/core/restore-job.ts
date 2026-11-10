/**
 * A restore is a job: accepted once every refusal it could meet before writing has been answered, then walked in
 * bounded passes. A pass spends no more than the invocation running it has left, and commits where the restore stands
 * after every unit of work, so a pass that runs out or dies keeps every unit before it and the next pass converges from
 * there. One runs at a time. A restore is always finished, failed with its outcome so far, or running with a cursor the
 * tick resumes from.
 */
import type { ServerEnv } from './adapters.js';
import {
  admitRestore, backupArtifact, BackupApplyError, BackupFormatRetiredError, BackupIntegrityError, BackupLineageError, BackupObjectsMissingError,
  BackupSchemaError, invocationSpent, RESTORE_START, restorePass, type RestoreCursor, type RestoreDocuments, type RestoreOptions,
  type RestoreOutcome, type RestorePace, type RestorePhase,
} from './backup.js';
import { remainingInvocationBudget } from './content-budget.js';
import { RestoreAuthorizationError } from './restore-authorization.js';
import { readStoredObject } from './stored-object.js';
import { PublicationRestoreBuilding } from '../db/documents/readiness.js';
import { RecordSchemeError } from '../db/documents/record-pins.js';
import { sha256Hex, utf8 } from '../hash.js';
import { classify, emit } from '../telemetry.js';
import {
  advanceRestoreJob, completeRestoreJob, failRestoreJob, latestRestoreJob, noteRestoreRetry, recordRestoreJob, restoreJob,
  runningRestoreJob, type RestoreJobRow, type RestoreJobState,
} from '../db/recovery/restore-jobs.js';

/** What a running job names on itself while it waits for an owner's request to place session documents. */
const AWAITING_DOCUMENTS = 'awaiting_documents';
/** What a running job names on itself when a pass with room for a unit committed none. */
const PASS_EXCEEDS_ALLOWANCE = 'pass_exceeds_allowance';
/** Artifact rows one pass walks at most, however much the invocation has left. */
const RESTORE_PASS_ROWS = 2_000;
/** Passes in a row that may end without moving the restore before it stops, named. */
const RESTORE_RETRY_LIMIT = 5;
/** Passes in a row that may wait for publication catch-up to finish building before the restore stops, named. */
const RESTORE_BUILDING_LIMIT = 30;
/** How long a pass waits for an uploaded artifact's bytes to land after its job was accepted. */
const UPLOAD_GRACE_MS = 60_000;
/** What one unit of a pass may spend at most: a pass starts no unit with less than this left. */
const UNIT_STATEMENTS = 80;
const UNIT_BLOB_CALLS = 8;
/**
 * The room a pass must begin with for committing nothing to count against the restore: several units' worth. A pass
 * that began on what earlier jobs in its wake left tries, and waits for the next wake uncounted if nothing fit.
 */
const COUNTED_UNITS = 5;
const UNIT_WALL_MS = 200;
/** Where an uploaded artifact's bytes are kept while its restore runs. */
const UPLOAD_PREFIX = 'restores/';

/** Why a restore stopped, by the code the routes and the dashboard name it with. */
export interface RestoreFailure { code: string; message: string }

export interface RestoreJobProgress {
  id: string;
  /** The catalogued backup the restore reads, or null for an uploaded artifact. */
  backupId: string | null;
  state: RestoreJobState;
  /** The stage the next pass begins at: `done` once the restore finished. */
  phase: RestorePhase;
  rowsDone: number;
  rowsTotal: number;
  acceptedAt: number;
  updatedAt: number;
  completedAt: number | null;
  /** What the restore has added so far, or in all once it is complete. */
  outcome: RestoreOutcome;
  /** Why a failed restore stopped. The rows it restored before that stay; restoring the same backup again continues it. */
  failure: RestoreFailure | null;
  /** The error class the latest pass of a running restore ended on; the next wake tries the same pass again. */
  retrying: { errorClass: string; at: number } | null;
  /**
   * The restore has reached session documents, which only an owner's request places (the restore's continue route); the
   * tick never reads documents, so the job waits here, with everything before it restored.
   */
  awaitingDocuments: boolean;
}

export const restoreProgress = (row: RestoreJobRow): RestoreJobProgress => ({
  id: row.id,
  backupId: row.backup_id,
  state: row.state,
  phase: (JSON.parse(row.cursor) as RestoreCursor).phase,
  rowsDone: row.rows_done,
  rowsTotal: row.rows_total,
  acceptedAt: row.accepted_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  outcome: JSON.parse(row.outcome) as RestoreOutcome,
  failure: row.state === 'failed' ? { code: row.failure ?? 'restore_failed', message: row.failure_detail ?? '' } : null,
  retrying: row.state === 'running' && row.failure !== null && row.failure !== AWAITING_DOCUMENTS ? { errorClass: row.failure, at: row.failed_at ?? row.updated_at } : null,
  awaitingDocuments: row.state === 'running' && row.failure === AWAITING_DOCUMENTS,
});

/** A refusal the restore met: named, final for this job, and answered to the owner in the words its message carries. */
export function restoreFailure(error: unknown): RestoreFailure | null {
  if (error instanceof BackupLineageError) return { code: 'foreign_lineage', message: error.message };
  if (error instanceof BackupSchemaError) return { code: 'newer_schema', message: error.message };
  if (error instanceof BackupObjectsMissingError) return { code: 'objects_missing', message: error.message };
  if (error instanceof BackupIntegrityError) return { code: 'artifact_integrity', message: error.message };
  if (error instanceof BackupFormatRetiredError) return { code: error.code, message: error.message };
  if (error instanceof RestoreAuthorizationError) return { code: error.code, message: error.message };
  if (error instanceof RecordSchemeError) return { code: error.code, message: error.message };
  if (error instanceof BackupApplyError) return { code: 'restore_refused', message: error.message };
  if (error instanceof SyntaxError) return { code: 'artifact_unreadable', message: 'the artifact is not a backup this server can read' };
  return null;
}

/** Another restore is running; it finishes or fails before another is accepted. */
export class RestoreRunningError extends Error {
  constructor(readonly runningId: string | null) {
    super(`another restore is running${runningId === null ? '' : ` (${runningId})`}; wait for it to finish, or stop it with POST /api/backups/restores/${runningId ?? '{restoreId}'}/stop, then restore again`);
    this.name = 'RestoreRunningError';
  }
}
/** The backup was released, or its bytes changed, while the restore was being accepted. */
export class RestoreBackupGoneError extends Error {
  constructor() {
    super('the backup was released or changed while the restore was being accepted; nothing was restored');
    this.name = 'RestoreBackupGoneError';
  }
}

/**
 * Who asks for a restore and how. `documents` is the document side of a restore, which only a request supplies: the
 * tick never reads session documents.
 */
export interface RestoreRequest { allowForeignLineage: boolean; memberId: string; now: number; documents?: RestoreDocuments }

const restoreOptions = (env: Pick<ServerEnv, 'blobs'>, text: string, request: RestoreRequest): RestoreOptions => ({
  text, blobs: env.blobs, allowForeignLineage: request.allowForeignLineage,
  authorization: { kind: 'member', memberId: request.memberId }, now: request.now, documents: request.documents,
});

async function recordJob(env: Pick<ServerEnv, 'db'>, id: string, source: { backupId: string } | { upload: { key: string; size: number } },
  request: RestoreRequest, admitted: Awaited<ReturnType<typeof admitRestore>>): Promise<RestoreJobRow> {
  const recorded = await recordRestoreJob(env.db, {
    id, source, sha256: admitted.hash, requestedBy: request.memberId, adoptLineage: request.allowForeignLineage,
    cursor: JSON.stringify(RESTORE_START), rowsTotal: admitted.rowsTotal, outcome: JSON.stringify(admitted.outcome), now: request.now,
  });
  if ('job' in recorded) return recorded.job;
  if (recorded.refused === 'running') throw new RestoreRunningError(recorded.runningId);
  throw new RestoreBackupGoneError();
}

/** Refuses before any read of the artifact while another restore runs; the job's own commit is what decides it. */
async function refuseWhileRunning(env: Pick<ServerEnv, 'db'>): Promise<void> {
  const running = await runningRestoreJob(env.db);
  if (running !== null) throw new RestoreRunningError(running.id);
}

/**
 * Accepts a restore of a catalogued backup: reads and verifies its artifact, answers every refusal it would meet
 * before writing, and records the job that owns it. Writes nothing of the artifact. Null when no such backup exists.
 */
export async function acceptRestore(env: Pick<ServerEnv, 'db' | 'blobs'>, backupId: string, request: RestoreRequest): Promise<RestoreJobProgress | null> {
  await refuseWhileRunning(env);
  const artifact = await backupArtifact(env.db, env.blobs, backupId);
  if (artifact === null) return null;
  const admitted = await admitRestore(env.db, restoreOptions(env, artifact.text, request));
  return restoreProgress(await recordJob(env, `rs_${crypto.randomUUID()}`, { backupId }, request, admitted));
}

/**
 * Accepts a restore of an artifact carried in the request: admits it as a stored backup's restore is admitted, records
 * the job, then keeps the bytes under a key the job owns for its passes to read. The bytes are not one of this
 * Deployment's backups; the commit that ends the job releases them. A job whose bytes could not be kept ends failed.
 */
export async function acceptUploadedRestore(env: Pick<ServerEnv, 'db' | 'blobs'>, text: string, request: RestoreRequest): Promise<RestoreJobProgress> {
  await refuseWhileRunning(env);
  const admitted = await admitRestore(env.db, restoreOptions(env, text, request));
  const id = `rs_${crypto.randomUUID()}`;
  const bytes = utf8(text);
  const key = `${UPLOAD_PREFIX}${id}.jsonl`;
  const job = await recordJob(env, id, { upload: { key, size: bytes.byteLength } }, request, admitted);
  try {
    await env.blobs.put(key, new Response(bytes).body, { sha256: admitted.hash, httpMetadata: { contentType: 'application/jsonl' } });
  } catch (error) {
    const failed = await failRestoreJob(env.db, job, { code: 'upload_unavailable', detail: 'the uploaded backup could not be kept for the restore; nothing was restored. Upload it again', now: request.now });
    emit({ kind: 'restore_upload_failed', error_class: classify(error) });
    return restoreProgress(failed ?? job);
  }
  return restoreProgress(job);
}

/**
 * The artifact a job reads: its catalogued backup, or the bytes its upload is kept under; null when they are gone, and
 * `pending` while an upload's bytes may still be landing: the job has never moved and was accepted moments ago.
 */
async function jobArtifact(env: Pick<ServerEnv, 'db' | 'blobs'>, job: RestoreJobRow, now: number): Promise<string | null | 'pending'> {
  if (job.backup_id !== null) return (await backupArtifact(env.db, env.blobs, job.backup_id))?.text ?? null;
  const stored = await readStoredObject(env.blobs, job.upload_key!, job.upload_size!);
  if (stored.kind === 'absent') return job.revision === 0 && now - job.accepted_at < UPLOAD_GRACE_MS ? 'pending' : null;
  if (stored.kind === 'size_mismatch') throw new BackupIntegrityError(job.id, 'size');
  return new TextDecoder().decode(stored.bytes);
}

/** What one pass of the running restore did. */
export interface RestoreAdvance { job: RestoreJobProgress | null; walked: number; more: boolean }

/**
 * A pass paced by what the invocation behind `env.db` has left, committing where the restore stands after each unit.
 * An invocation that states no allowance is paced by rows alone.
 */
function paceFor(env: Pick<ServerEnv, 'db'>, job: RestoreJobRow, now: number): RestorePace & { revision(): number } {
  let revision = job.revision;
  return {
    exhausted() {
      const left = remainingInvocationBudget(env.db);
      return left !== null && (left.statements < UNIT_STATEMENTS || left.blobCalls < UNIT_BLOB_CALLS || left.wallMs < UNIT_WALL_MS);
    },
    async checkpoint({ cursor, outcome, walked }) {
      const next = await advanceRestoreJob(env.db, { id: job.id, revision }, {
        cursor: JSON.stringify(cursor), rowsDone: Math.min(job.rows_done + walked, job.rows_total), outcome: JSON.stringify(outcome), now,
      });
      if (next === null) return false;
      revision = next;
      return true;
    },
    revision: () => revision,
  };
}

/**
 * Takes one pass of the running restore, if one is running: reads its artifact, holds the bytes to the digest it was
 * accepted on, and walks from its cursor for as long as the invocation has room, committing after every unit. A
 * refusal ends the job failed with what it restored so far. A pass that moved the restore and ran out leaves the job
 * where its last unit did. A pass that began with room for a unit and moved nothing, on an error or on a spent
 * invocation, is named on the job, which keeps its place; `RESTORE_RETRY_LIMIT` such passes in a row end it failed,
 * named. Only a pass that moves the restore resets the count.
 */
export async function advanceRestore(env: Pick<ServerEnv, 'db' | 'blobs'> & Partial<Pick<ServerEnv, 'platform'>>, now: number, rows = RESTORE_PASS_ROWS, documents?: RestoreDocuments): Promise<RestoreAdvance> {
  const job = await runningRestoreJob(env.db);
  if (job === null) return { job: null, walked: 0, more: false };
  // A job waiting for documents stays waiting until a request brings the document side; the tick reads nothing for it.
  if (documents === undefined && job.failure === AWAITING_DOCUMENTS) return { job: null, walked: 0, more: false };
  const pace = paceFor(env, job, now);
  // A wake that earlier work left without room for one unit tries again at the next wake; it says nothing of the job.
  if (pace.exhausted()) return { job: null, walked: 0, more: false };
  const end = async (failure: RestoreFailure): Promise<RestoreAdvance> => {
    const failed = await failRestoreJob(env.db, { id: job.id, revision: pace.revision() }, { code: failure.code, detail: failure.message, now });
    emit({ kind: 'restore_job_failed', code: failure.code });
    return { job: failed === null ? null : restoreProgress(failed), walked: 0, more: false };
  };
  const stalled = async (errorClass: string, walked: number, limit = RESTORE_RETRY_LIMIT): Promise<RestoreAdvance> => {
    let retries: number | null;
    try {
      retries = await noteRestoreRetry(env.db, { id: job.id, revision: pace.revision() }, errorClass, now, true);
    } catch (error) {
      // A pass that spent the whole invocation cannot record itself; the next wake tries again.
      if (invocationSpent(error)) return { job: null, walked, more: false };
      throw error;
    }
    if (retries !== null && retries >= limit) {
      return end({ code: 'retries_exhausted', message: `the restore stopped after ${retries} passes in a row moved nothing (${errorClass}); the rows it restored stay. Restore the same backup again once the cause is resolved` });
    }
    return { job: null, walked, more: false };
  };
  const moved = () => pace.revision() !== job.revision;
  const room = remainingInvocationBudget(env.db);
  const counted = room === null || (room.statements >= COUNTED_UNITS * UNIT_STATEMENTS && room.blobCalls >= COUNTED_UNITS * UNIT_BLOB_CALLS
    && room.wallMs >= COUNTED_UNITS * UNIT_WALL_MS);
  try {
    const text = await jobArtifact(env, job, now);
    if (text === 'pending') {
      await noteRestoreRetry(env.db, job, 'upload_pending', now, false);
      return { job: null, walked: 0, more: false };
    }
    if (text === null) return end({ code: 'backup_unavailable', message: job.upload_key === null
      ? 'the backup this restore reads is no longer stored; the rows it restored stay'
      : 'the uploaded backup this restore reads is not stored; the rows it restored stay. Upload it again to finish the restore' });
    if (await sha256Hex(text) !== job.artifact_sha256) {
      return end({ code: 'artifact_integrity', message: 'the backup this restore reads changed after the restore was accepted; the rows it restored stay' });
    }
    const pass = await restorePass(env.db, restoreOptions(env, text, { allowForeignLineage: job.adopt_lineage === 1, memberId: job.requested_by, now, documents }), {
      from: JSON.parse(job.cursor) as RestoreCursor, rows, outcome: JSON.parse(job.outcome) as RestoreOutcome, admitted: true, pace,
    });
    if (pass.moved) return { job: null, walked: pass.walked, more: true };
    if (pass.next.phase === 'done') {
      const completed = await completeRestoreJob(env.db, { id: job.id, revision: pace.revision() }, {
        cursor: JSON.stringify(pass.next), rowsDone: job.rows_total, outcome: JSON.stringify(pass.outcome), now,
      });
      return { job: completed === null ? null : restoreProgress(completed), walked: pass.walked, more: false };
    }
    if (pass.awaitingDocuments) {
      // Waiting for an owner's request is not a pass that failed: it leaves the count where it stands.
      await noteRestoreRetry(env.db, { id: job.id, revision: pace.revision() }, AWAITING_DOCUMENTS, now, false);
      return { job: null, walked: pass.walked, more: false };
    }
    // A pass that ran out before committing one unit would run out the same way at every wake.
    if (moved()) return { job: null, walked: pass.walked, more: true };
    return counted ? stalled(PASS_EXCEEDS_ALLOWANCE, pass.walked) : { job: null, walked: pass.walked, more: false };
  } catch (error) {
    const failure = restoreFailure(error);
    if (failure !== null) return end(failure);
    // A spent invocation after a committed unit is not an error: the next wake goes on from there.
    if (invocationSpent(error)) {
      if (moved()) return { job: null, walked: 0, more: true };
      return counted ? stalled(PASS_EXCEEDS_ALLOWANCE, 0) : { job: null, walked: 0, more: false };
    }
    const errorClass = error instanceof PublicationRestoreBuilding ? error.code : classify(error, env.platform?.classifyError);
    emit({ kind: 'restore_pass_failed', error_class: errorClass });
    // Publication catch-up still building is waited out for longer; metadata that needs a repair is not.
    return stalled(errorClass, 0, errorClass === 'publication_restore_building' ? RESTORE_BUILDING_LIMIT : RESTORE_RETRY_LIMIT);
  }
}

/**
 * Stops a running restore at the owner's request: the job ends failed with `stopped`, keeping every row it restored,
 * and the backup it held is free for retention again. Answers the ended job, or why it could not be stopped.
 */
export async function stopRestore(env: Pick<ServerEnv, 'db'>, id: string, now: number): Promise<
  { stopped: RestoreJobProgress } | { refused: 'absent' } | { refused: 'ended'; job: RestoreJobProgress } | { refused: 'moved' }> {
  const job = await restoreJob(env.db, id);
  if (job === null) return { refused: 'absent' };
  if (job.state !== 'running') return { refused: 'ended', job: restoreProgress(job) };
  const stopped = await failRestoreJob(env.db, job, { code: 'stopped', detail: 'the restore was stopped by its owner; the rows it restored stay, and restoring the same backup again continues it', now });
  return stopped === null ? { refused: 'moved' } : { stopped: restoreProgress(stopped) };
}

/** One restore's progress, or null when this Deployment has no restore of that id. */
export async function restoreJobProgress(env: Pick<ServerEnv, 'db'>, id: string): Promise<RestoreJobProgress | null> {
  const row = await restoreJob(env.db, id);
  return row === null ? null : restoreProgress(row);
}

/** The latest restore this Deployment accepted, running or finished, for the backup page. */
export async function latestRestore(env: Pick<ServerEnv, 'db'>): Promise<RestoreJobProgress | null> {
  const row = await latestRestoreJob(env.db);
  return row === null ? null : restoreProgress(row);
}
