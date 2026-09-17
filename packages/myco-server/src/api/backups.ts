/**
 * The backup surface: create, list, preview, restore, pin. Owner routes on the
 * dashboard session; every behavior lives in `core/backup.ts` — these handlers
 * decide only how a request is asked for and answered. The artifact carries
 * relational rows alone; object-store bytes and the operator-entered
 * configuration tables stay outside it, and the UI says so.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import {
  BackupApplyError, backupArtifact, BackupIntegrityError, BackupObjectsMissingError, BackupLineageError, BackupSchemaError, BackupTooLargeError,
  assertBackupSize, createBackup, listBackups, previewRestore, pruneBackups,
  restoreArtifact, restoreBackup, setBackupPinned,
} from '../core/backup.js';
import { backupRetentionPolicy } from '../core/backup-retention.js';
import { badRequest, notFound, ok, readJsonObject } from './scope.js';


/** The answer for a stored artifact the read path refused: bytes that differ from the evidence its row recorded, or a recorded size past the artifact bound. Neither carries artifact content. */
const storedArtifactRefusal = (err: unknown): Response | null => {
  if (err instanceof BackupIntegrityError) return Response.json({ error: 'artifact_integrity', message: err.message }, { status: 409 });
  if (err instanceof BackupTooLargeError) return badRequest(err.message);
  return null;
};

/** Create one backup, then prune per the retention leaves — fail-closed, in `core/backup.ts`. */
export async function handleCreateBackup(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const policy = await backupRetentionPolicy(env.db);
  try {
    const backup = await createBackup(env.db, env.blobs, { producer: ctx.member.id, now: ctx.now });
    const pruned = await pruneBackups(env.db, policy, ctx.now);
    return ok({ backup, pruned: pruned.pruned });
  } catch (err) {
    if (err instanceof BackupTooLargeError) return badRequest(err.message);
    throw err;
  }
}

/** Every backup the index holds, each verified against the object store. */
export async function handleListBackups(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return ok({ backups: await listBackups(env.db, env.blobs) });
}

/** What a restore would touch, from the artifact's header alone. */
export async function handleRestorePreview(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  try {
    const preview = await previewRestore(env.db, env.blobs, ctx.params.backupId);
    if (preview === null) return notFound();
    return ok(preview);
  } catch (err) {
    const refusal = storedArtifactRefusal(err);
    if (refusal !== null) return refusal;
    throw err;
  }
}

/** Apply one backup. A foreign-lineage artifact is refused unless the body deliberately adopts it. */
export async function handleRestoreBackup(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  try {
    const outcome = await restoreBackup(env.db, env.blobs, {
      id: ctx.params.backupId,
      allowForeignLineage: body.allowForeignLineage === true,
    });
    if (outcome === null) return notFound();
    return ok({ applied: true, ...outcome });
  } catch (err) {
    if (err instanceof BackupLineageError) {
      return Response.json({ error: 'foreign_lineage', message: err.message }, { status: 409 });
    }
    if (err instanceof BackupSchemaError) {
      return Response.json({ error: 'newer_schema', message: err.message }, { status: 409 });
    }
    if (err instanceof BackupObjectsMissingError) {
      return Response.json({ error: 'objects_missing', message: err.message }, { status: 409 });
    }
    const refusal = storedArtifactRefusal(err);
    if (refusal !== null) return refusal;
    if (err instanceof BackupApplyError || err instanceof SyntaxError) return badRequest(err.message);
    throw err;
  }
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

/** Restore an artifact carried in the request itself — the way a backup taken on one Deployment lands on another. */
export async function handleRestoreUpload(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null || typeof body.artifact !== 'string' || body.artifact.length === 0) {
    return badRequest('body must carry the artifact text');
  }
  try {
    assertBackupSize(body.artifact);
    const outcome = await restoreArtifact(env.db, { text: body.artifact, allowForeignLineage: body.allowForeignLineage === true });
    return ok({ applied: true, ...outcome });
  } catch (err) {
    if (err instanceof BackupLineageError) return Response.json({ error: 'foreign_lineage', message: err.message }, { status: 409 });
    if (err instanceof BackupSchemaError) return Response.json({ error: 'newer_schema', message: err.message }, { status: 409 });
    if (err instanceof BackupObjectsMissingError) return Response.json({ error: 'objects_missing', message: err.message }, { status: 409 });
    if (err instanceof BackupTooLargeError) return badRequest('the artifact is past the byte bound this path serves');
    if (err instanceof BackupApplyError) return badRequest(err.message);
    if (err instanceof SyntaxError) return badRequest('the artifact is not a backup this server can read');
    throw err;
  }
}

/** Pin or unpin one backup; a pinned backup is exempt from retention. */
export async function handlePinBackup(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null || typeof body.pinned !== 'boolean') return badRequest('body must carry pinned: true or false');
  const changed = await setBackupPinned(env.db, ctx.params.backupId, body.pinned);
  if (!changed) return notFound();
  return ok({ pinned: body.pinned });
}
