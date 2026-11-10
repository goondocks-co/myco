import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { RestoreOptions, RestoreOutcome } from '@myco-server-worker/core/backup.js';
import { acceptUploadedRestore, advanceRestore, restoreJobProgress } from '@myco-server-worker/core/restore-job.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { bootstrapOwnership } from '@myco-server-worker/db/identity/ownership.js';
import { restoreDocuments } from '@myco-server-worker/ingest/document-restore.js';
import { memoryBlobStore } from './fixtures.js';

/** A restore that ended failed, carrying its named code and words. */
export class RestoreJobFailed extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RestoreJobFailed';
  }
}

const RESTORE_OWNER = 'mem_restore_owner';

/**
 * An artifact restored the way an owner's upload is: admitted, recorded as a job, and walked by passes with the
 * document side a request brings until the job ends. Answers the outcome, or throws the admission's refusal or the
 * failed job's code. The destination's owner asks; one is recorded first when the Deployment has none.
 */
export async function restoreThroughJob(db: RelationalStore, opts: Omit<RestoreOptions, 'authorization'> & { authorization?: unknown }): Promise<RestoreOutcome> {
  const blobs = opts.blobs ?? memoryBlobStore();
  const now = opts.now ?? Date.now();
  const owner = await db.prepare('SELECT member_id FROM deployment_ownership WHERE id = 1').first<{ member_id: string | null }>();
  let memberId = owner?.member_id ?? null;
  if (memberId === null) {
    await ensureMember(db, RESTORE_OWNER, now, 'admin');
    await db.prepare('UPDATE members SET github_id = ? WHERE id = ? AND github_id IS NULL').bind('restore-owner-github', RESTORE_OWNER).run();
    await bootstrapOwnership(db, RESTORE_OWNER, RESTORE_OWNER, '0', now);
    memberId = RESTORE_OWNER;
  }
  const env = { db, blobs };
  const documents = restoreDocuments(env);
  const accepted = await acceptUploadedRestore(env, opts.text, { allowForeignLineage: opts.allowForeignLineage === true, memberId, now, documents });
  for (let pass = 0; pass < 1_000 && (await restoreJobProgress(env, accepted.id))?.state === 'running'; pass++) await advanceRestore(env, now, undefined, documents);
  const job = await restoreJobProgress(env, accepted.id);
  if (job?.state !== 'complete') throw new RestoreJobFailed(job?.failure?.code ?? 'restore_not_finished', job?.failure?.message ?? '');
  return job.outcome;
}
