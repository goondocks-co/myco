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
  BackupObjectsMissingError,
  BackupLineageError,
  BackupSchemaError,
  BackupTooLargeError,
  assertBackupSize,
  createBackup,
  previewRestore,
  restoreArtifact,
  restoreBackup,
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
import { RecordSchemeError } from '../ingest/record-scheme.js';
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
}

/** One page of the backup index, newest first, each row with the verification last recorded for it. */
export async function handleListBackups(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const cursor = ctx.url.searchParams.get('cursor') ?? undefined;
  if (cursor !== undefined && decodeBackupCursor(cursor) === null) return badRequest('cursor is not one this server issued; omit it to read the newest page');
  const limitText = ctx.url.searchParams.get('limit');
  const limit = limitText === null ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > BACKUP_LIST_MAX)) return badRequest(`limit must be a whole number from 1 to ${BACKUP_LIST_MAX}`);
  const page = await listBackupPage(env.db, { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) });
  return ok({ ...page, retention: await backupPruneStatus(env.db) } satisfies BackupsAnswer);
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

/** A backup in the format before session documents: nothing was restored, and the message names where it still restores. */
const formatRetired = (err: BackupFormatRetiredError): Response =>
  Response.json({ error: err.code, message: err.message, retiredRows: err.counts }, { status: 409 });

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

/** Apply one backup. A foreign-lineage artifact is refused unless the body deliberately adopts it. */
export const handleRestoreBackup = retryablePublicationRestore(async (env: ServerEnv, ctx: OwnerContext): Promise<Response> => {
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  try {
    const outcome = await restoreBackup(env.db, env.blobs, {
      id: ctx.params.backupId,
      allowForeignLineage: body.allowForeignLineage === true,
      authorization: { kind: 'member', memberId: ctx.member.id },
      now: ctx.now,
      documents: restoreDocuments(env),
    });
    if (outcome === null) return notFound();
    return ok({ applied: true, ...outcome });
  } catch (err) {
    if (err instanceof RecordSchemeError) return Response.json({ error: err.code }, { status: 409 });
    if (err instanceof RestoreAuthorizationError) return Response.json({ error: err.code }, { status: err.code === 'owner_pending' ? 409 : 403 });
    if (err instanceof BackupLineageError) {
      return Response.json({ error: 'foreign_lineage', message: err.message }, { status: 409 });
    }
    if (err instanceof BackupSchemaError) {
      return Response.json({ error: 'newer_schema', message: err.message }, { status: 409 });
    }
    if (err instanceof BackupObjectsMissingError) {
      return Response.json({ error: 'objects_missing', message: err.message }, { status: 409 });
    }
    if (err instanceof BackupFormatRetiredError) return formatRetired(err);
    const refusal = storedArtifactRefusal(err);
    if (refusal !== null) return refusal;
    if (err instanceof BackupApplyError || err instanceof SyntaxError) return badRequest(err.message);
    throw err;
  }
});

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

/** Restore an artifact carried in the request itself — the way a backup taken on one Deployment lands on another. */
export const handleRestoreUpload = retryablePublicationRestore(async (env: ServerEnv, ctx: OwnerContext): Promise<Response> => {
  const body = await readJsonObject(ctx.request);
  if (body === null || typeof body.artifact !== 'string' || body.artifact.length === 0) {
    return badRequest('body must carry the artifact text');
  }
  try {
    assertBackupSize(body.artifact);
    const outcome = await restoreArtifact(env.db, { text: body.artifact, blobs: env.blobs, allowForeignLineage: body.allowForeignLineage === true, authorization: { kind: 'member', memberId: ctx.member.id }, now: ctx.now, documents: restoreDocuments(env) });
    return ok({ applied: true, ...outcome });
  } catch (err) {
    if (err instanceof RecordSchemeError) return Response.json({ error: err.code }, { status: 409 });
    if (err instanceof RestoreAuthorizationError) return Response.json({ error: err.code }, { status: err.code === 'owner_pending' ? 409 : 403 });
    if (err instanceof BackupLineageError) return Response.json({ error: 'foreign_lineage', message: err.message }, { status: 409 });
    if (err instanceof BackupSchemaError) return Response.json({ error: 'newer_schema', message: err.message }, { status: 409 });
    if (err instanceof BackupObjectsMissingError) return Response.json({ error: 'objects_missing', message: err.message }, { status: 409 });
    if (err instanceof BackupFormatRetiredError) return formatRetired(err);
    if (err instanceof BackupTooLargeError) return badRequest('the artifact is past the byte bound this path serves');
    if (err instanceof BackupApplyError) return badRequest(err.message);
    if (err instanceof SyntaxError) return badRequest('the artifact is not a backup this server can read');
    throw err;
  }
});

function retryablePublicationRestore(handler:(env:ServerEnv,ctx:OwnerContext)=>Promise<Response>) {
  return async (env:ServerEnv,ctx:OwnerContext):Promise<Response>=>{
    try { return await handler(env,ctx); }
    catch(error) {
      if(!(error instanceof PublicationRestoreBuilding))throw error;
      return Response.json({complete:false,error:error.code,retryable:error.retryable,message:error.message},{status:409});
    }
  };
}

/** Pin or unpin one backup; a pinned backup is exempt from retention. */
export async function handlePinBackup(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null || typeof body.pinned !== 'boolean') return badRequest('body must carry pinned: true or false');
  const changed = await setBackupPinned(env.db, ctx.params.backupId, body.pinned);
  if (!changed) return notFound();
  return ok({ pinned: body.pinned });
}
