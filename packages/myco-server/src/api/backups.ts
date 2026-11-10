import { PublicationRestoreBuilding } from '../db/documents/readiness.js';
/**
 * The backup surface: create, list, preview, restore, pin. Owner routes on the
 * dashboard session; every behavior lives in `core/backup.ts` — these handlers
 * decide only how a request is asked for and answered. The artifact carries
 * relational rows alone; object-store bytes and the operator-entered
 * configuration tables stay outside it, and the UI says so.
 */
import { restoreDocuments } from '../ingest/document-restore.js';
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import {
  BackupApplyError,
  backupArtifact,
  BackupIntegrityError,
  BackupFormatRetiredError,
  invocationSpent,
  BackupTooLargeError,
  assertBackupSize,
  createBackup,
  previewRestore,
  setBackupPinned,
  verifyBackup,
  type BackupIndexRow,
} from '../core/backup.js';
import {
  RelationalSnapshotAdmissionError as BackupAdmissionError,
} from '../core/relational-snapshot.js';
import { backupPruneStatus, type BackupPruneStatus, type BackupPruneOutcome } from '../db/meta/backup-prune.js';
import { pruneBackups } from '../core/backup-retention.js';
import { BACKUP_LIST_MAX, decodeBackupCursor, listBackupPage, type ListedBackup } from '../db/storage/backup-list.js';
import { restoreAdmission, RestoreAuthorizationError } from '../core/restore-authorization.js';
import { measuredContentEnv, CONTENT_WALL_MS } from '../core/content-budget.js';
import { WAKE_JOB_BLOB_LIMIT, WAKE_JOB_STATEMENT_LIMIT } from '../core/tick.js';
import {
  acceptRestore, acceptUploadedRestore, advanceRestore, latestRestore, restoreFailure, restoreJobProgress, RestoreBackupGoneError, RestoreRunningError, stopRestore,
  type RestoreFailure, type RestoreJobProgress,
} from '../core/restore-job.js';
import { badRequest, notFound, ok, readJsonObject } from './scope.js';

/** The dashboard's restore preview, with this caller's permission to apply it. */
export type RestorePreviewAnswer = Omit<NonNullable<Awaited<ReturnType<typeof previewRestore>>>, 'tableKeys'> & {
  restore: { allowed: boolean; reason: string | null };
};

/** The answer for a stored artifact the read path refused: bytes that differ from the evidence its row recorded, or a recorded size past the artifact bound. Neither carries artifact content. */
const storedArtifactRefusal = (err: unknown): Response | null => {
  if (err instanceof BackupIntegrityError) return Response.json({ error: 'artifact_integrity', message: err.message }, { status: 409 });
  if (err instanceof BackupTooLargeError) return badRequest(err.message);
  return null;
};

/** Create one backup, then prune per the retention leaves — fail-closed, in `core/backup.ts`. */
export async function handleCreateBackup(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  try {
    const backup = await createBackup(env.db, env.blobs, { producer: ctx.member.id, now: ctx.now });
    const pruned = await pruneBackups(env.db, ctx.now);
    return ok({ backup, retention: pruned } satisfies CreateBackupAnswer);
  } catch (err) {
    if (err instanceof BackupTooLargeError || err instanceof BackupAdmissionError) return badRequest(err.message);
    throw err;
  }
}

export interface CreateBackupAnswer {
  backup: BackupIndexRow;
  retention: BackupPruneOutcome;
}

export interface BackupsAnswer {
  backups: ListedBackup[];
  cursor: string | null;
  retention: BackupPruneStatus | null;
  /** The latest restore this Deployment accepted, running or ended. */
  restore: RestoreJobProgress | null;
}

/** One page of the backup index, newest first, each row with the verification last recorded for it. */
export async function handleListBackups(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const cursor = ctx.url.searchParams.get('cursor') ?? undefined;
  if (cursor !== undefined && decodeBackupCursor(cursor) === null) return badRequest('cursor is not one this server issued; omit it to read the newest page');
  const limitText = ctx.url.searchParams.get('limit');
  const limit = limitText === null ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > BACKUP_LIST_MAX)) return badRequest(`limit must be a whole number from 1 to ${BACKUP_LIST_MAX}`);
  const page = await listBackupPage(env.db, { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) });
  return ok({ ...page, retention: await backupPruneStatus(env.db), restore: await latestRestore(env) } satisfies BackupsAnswer);
}

/** Reads one artifact, compares it with what its row recorded, and records and answers the verification. */
export async function handleVerifyBackup(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  try {
    const verification = await verifyBackup(env.db, env.blobs, ctx.params.backupId, ctx.now);
    return verification === null ? notFound() : ok({ verification });
  } catch (err) {
    const refusal = storedArtifactRefusal(err);
    if (refusal !== null) return refusal;
    throw err;
  }
}

/** A backup in the format before session documents: nothing was restored, and the answer names the release that restores it. */
const formatRetired = (err: BackupFormatRetiredError): Response =>
  Response.json({ error: err.code, message: err.message, retiredRows: err.counts, restoresOn: err.restoresOn }, { status: 409 });

/** What a restore would touch, the authority a foreign-lineage restore lands without, and whether this member may apply its rows. */
export async function handleRestorePreview(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  try {
    const preview = await previewRestore(env.db, env.blobs, ctx.params.backupId, restoreDocuments(env));
    if (preview === null) return notFound();
    const admission = await restoreAdmission(env.db, { kind: 'member', memberId: ctx.member.id }, preview.tableKeys);
    const reasons = {
      not_owner: 'Only the owner can restore a backup that includes members or access authority.',
      owner_pending: 'An owner must be recorded before restoring a backup that includes members or access authority.',
      not_admin: 'An administrator can restore this backup.',
    } as const;
    const { tableKeys: _tableKeys, ...answer } = preview;
    return ok({ ...answer, restore: { allowed: admission.allowed, reason: admission.allowed ? null : reasons[admission.code] } } satisfies RestorePreviewAnswer);
  } catch (err) {
    const refusal = storedArtifactRefusal(err);
    if (refusal !== null) return refusal;
    if (err instanceof BackupFormatRetiredError) return formatRetired(err);
    if (err instanceof BackupApplyError) return badRequest(err.message);
    if (err instanceof SyntaxError) return badRequest('the artifact is not a backup this server can read');
    throw err;
  }
}


/** What a restore request answers: the outcome once complete, or the job still running with its progress. */
export type RestoreAnswer =
  | ({ applied: true; job: RestoreJobProgress } & RestoreJobProgress['outcome'])
  | { applied: false; job: RestoreJobProgress };

/** A refusal met before any job was recorded, answered with its named code as the routes always have. */
function refusedRestore(failure: RestoreFailure): Response {
  switch (failure.code) {
    case 'not_owner': case 'not_admin': return Response.json({ error: failure.code }, { status: 403 });
    case 'owner_pending': return Response.json({ error: failure.code }, { status: 409 });
    case 'foreign_lineage': case 'newer_schema': case 'objects_missing': case 'artifact_integrity': case 'backup_unavailable':
      return Response.json({ error: failure.code, message: failure.message }, { status: 409 });
    case 'restore_refused': case 'artifact_unreadable': return badRequest(failure.message);
    default: return Response.json({ error: failure.code }, { status: 409 });
  }
}

/** A restore that ended failed: its named code, its words, and the job with the rows it restored before it stopped. */
const failedRestore = (job: RestoreJobProgress): Response =>
  Response.json({ error: job.failure?.code ?? 'restore_failed', message: job.failure?.message ?? '', job }, { status: 409 });

/** What a restore request may spend: the same allowance the tick gives one wake's jobs. */
const requestAllowance = (env: ServerEnv): ServerEnv =>
  measuredContentEnv(env, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: WAKE_JOB_BLOB_LIMIT, wallMs: CONTENT_WALL_MS }).env;

/** The refusals that come before a job exists, by the same codes a stopped job carries. */
function refusedAcceptance(err: unknown): Response | null {
  if (err instanceof RestoreRunningError) return Response.json({ error: 'restore_running', message: err.message, restoreId: err.runningId }, { status: 409 });
  if (err instanceof RestoreBackupGoneError) return Response.json({ error: 'backup_unavailable', message: err.message }, { status: 409 });
  if (err instanceof PublicationRestoreBuilding) return Response.json({ complete: false, error: err.code, retryable: err.retryable, message: err.message }, { status: 409 });
  if (err instanceof BackupFormatRetiredError) return formatRetired(err);
  const failure = restoreFailure(err);
  return failure === null ? null : refusedRestore(failure);
}

/**
 * Walks the restore this request accepted for one bounded pass, then answers it: complete with what each
 * table took, stopped with its refusal, or still running (202) with its progress, which the tick carries on.
 */
async function answerAccepted(env: ServerEnv, accepted: RestoreJobProgress, now: number): Promise<Response> {
  const measured = requestAllowance(env);
  try { await advanceRestore(measured, now, undefined, restoreDocuments(measured)); }
  catch (error) { if (!invocationSpent(error)) throw error; }
  const job = (await restoreJobProgress(env, accepted.id)) ?? accepted;
  if (job.state === 'complete') return ok({ applied: true, job, ...job.outcome } satisfies RestoreAnswer);
  if (job.state === 'failed') return failedRestore(job);
  await env.wake?.().catch(() => undefined);
  return Response.json({ applied: false, job } satisfies RestoreAnswer, { status: 202 });
}

/** Accept a restore of one backup. A foreign-lineage artifact is refused unless the body deliberately adopts it. */
export async function handleRestoreBackup(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  let accepted: RestoreJobProgress | null;
  try {
    accepted = await acceptRestore(env, ctx.params.backupId, { allowForeignLineage: body.allowForeignLineage === true, memberId: ctx.member.id, now: ctx.now, documents: restoreDocuments(env) });
  } catch (err) {
    const refusal = refusedAcceptance(err) ?? storedArtifactRefusal(err);
    if (refusal !== null) return refusal;
    throw err;
  }
  if (accepted === null) return notFound();
  return answerAccepted(env, accepted, ctx.now);
}

/**
 * Carries the running restore one bounded pass further from an owner's request, with the document side the tick does
 * not have: what a restore waiting at session documents needs. Answers as the request that accepted it does.
 */
export async function handleContinueRestore(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const job = await restoreJobProgress(env, ctx.params.restoreId);
  if (job === null) return notFound();
  if (job.state !== 'running') return Response.json({ error: 'restore_ended', message: `this restore is ${job.state}; there is nothing to continue. Read it with GET /api/backups/restores/${job.id}, or start another restore`, job }, { status: 409 });
  return answerAccepted(env, job, ctx.now);
}

/**
 * Stops a running restore: it ends failed with `stopped`, keeping every row it restored, and its backup is free for
 * retention again. Each refusal names the call to make next.
 */
export async function handleStopRestore(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const answer = await stopRestore(env, ctx.params.restoreId, ctx.now);
  if ('stopped' in answer) return ok({ job: answer.stopped });
  if (answer.refused === 'absent') return notFound();
  if (answer.refused === 'ended') return Response.json({ error: 'restore_ended', message: `this restore is already ${answer.job.state}; there is nothing to stop. Read it with GET /api/backups/restores/${answer.job.id}`, job: answer.job }, { status: 409 });
  return Response.json({ error: 'restore_moved', message: `a pass moved this restore while it was being stopped; read it with GET /api/backups/restores/${ctx.params.restoreId} and stop it again if it is still running` }, { status: 409 });
}

/** One restore's progress and outcome, while it runs and after it ends. */
export async function handleRestoreProgress(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const job = await restoreJobProgress(env, ctx.params.restoreId);
  return job === null ? notFound() : ok({ job });
}

/** The artifact itself, for an operator taking a copy off the Deployment. */
export async function handleBackupArtifact(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  let artifact;
  try {
    artifact = await backupArtifact(env.db, env.blobs, ctx.params.backupId);
  } catch (err) {
    const refusal = storedArtifactRefusal(err);
    if (refusal !== null) return refusal;
    throw err;
  }
  if (artifact === null) return notFound();
  return new Response(artifact.text, {
    headers: {
      'content-type': 'application/jsonl',
      'content-disposition': `attachment; filename="${artifact.row.key.split('/').pop()}"`,
    },
  });
}

/**
 * Restore an artifact carried in the request itself — the way a backup taken on one Deployment lands on another. Its
 * restore runs as a job exactly as a stored backup's does; the bytes are kept for the job alone, never listed as one of
 * this Deployment's backups, and released when the job ends.
 */
export async function handleRestoreUpload(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null || typeof body.artifact !== 'string' || body.artifact.length === 0) {
    return badRequest('body must carry the artifact text');
  }
  let accepted: RestoreJobProgress;
  try {
    assertBackupSize(body.artifact);
    accepted = await acceptUploadedRestore(env, body.artifact, { allowForeignLineage: body.allowForeignLineage === true, memberId: ctx.member.id, now: ctx.now, documents: restoreDocuments(env) });
  } catch (err) {
    if (err instanceof BackupTooLargeError) return badRequest('the artifact is past the byte bound this path serves');
    const refusal = refusedAcceptance(err);
    if (refusal !== null) return refusal;
    throw err;
  }
  return answerAccepted(env, accepted, ctx.now);
}

/** Pin or unpin one backup; a pinned backup is exempt from retention. */
export async function handlePinBackup(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null || typeof body.pinned !== 'boolean') return badRequest('body must carry pinned: true or false');
  const changed = await setBackupPinned(env.db, ctx.params.backupId, body.pinned);
  if (!changed) return notFound();
  return ok({ pinned: body.pinned });
}
