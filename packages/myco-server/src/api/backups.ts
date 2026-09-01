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
  BackupApplyError, backupArtifact, BackupLineageError, BackupSchemaError, BackupTooLargeError,
  createBackup, listBackups, MAX_BACKUP_BYTES, previewRestore, pruneBackups,
  restoreArtifact, restoreBackup, setBackupPinned,
} from '../core/backup.js';
import { leafValues } from '../core/settings.js';
import { badRequest, notFound, ok, readJsonObject } from './scope.js';

const KEEP_DAILY_DEFAULT = 14;
const KEEP_WEEKLY_DEFAULT = 8;

const leafNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  } catch { return fallback; }
};

/** Create one backup, then prune per the retention leaves — fail-closed, in `core/backup.ts`. */
export async function handleCreateBackup(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const leaves = await leafValues(env.db, ['backup.retention.keep_daily', 'backup.retention.keep_weekly']);
  try {
    const backup = await createBackup(env.db, env.blobs, { producer: ctx.member.id, now: ctx.now });
    const pruned = await pruneBackups(env.db, env.blobs, {
      keepDaily: leafNumber(leaves.get('backup.retention.keep_daily'), KEEP_DAILY_DEFAULT),
      keepWeekly: leafNumber(leaves.get('backup.retention.keep_weekly'), KEEP_WEEKLY_DEFAULT),
    });
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
  const preview = await previewRestore(env.db, env.blobs, ctx.params.backupId);
  if (preview === null) return notFound();
  return ok(preview);
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
    if (err instanceof BackupApplyError || err instanceof SyntaxError) return badRequest(err.message);
    throw err;
  }
}

/** The artifact itself, for an operator taking a copy off the Deployment. */
export async function handleBackupArtifact(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const artifact = await backupArtifact(env.db, env.blobs, ctx.params.backupId);
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
  if (body.artifact.length > MAX_BACKUP_BYTES) return badRequest('the artifact is past the byte bound this path serves');
  try {
    const outcome = await restoreArtifact(env.db, { text: body.artifact, allowForeignLineage: body.allowForeignLineage === true });
    return ok({ applied: true, ...outcome });
  } catch (err) {
    if (err instanceof BackupLineageError) return Response.json({ error: 'foreign_lineage', message: err.message }, { status: 409 });
    if (err instanceof BackupSchemaError) return Response.json({ error: 'newer_schema', message: err.message }, { status: 409 });
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
