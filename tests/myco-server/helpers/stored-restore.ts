import type { BlobStore, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { backupArtifact, type RestoreOptions, type RestoreOutcome } from '@myco-server-worker/core/backup.js';
import { restoreArtifact } from './restore-artifact.js';

/**
 * A catalogued backup restored in one call: its artifact read and verified as every restore reads it, then walked to
 * the end. Null when no such backup exists. A restore job walks the same artifact in passes; this is for tests whose
 * subject is what a restore writes, not how a job paces it.
 */
export async function restoreStoredBackup(db: RelationalStore, blobs: BlobStore, opts: { id: string } & Omit<RestoreOptions, 'text' | 'blobs'>): Promise<RestoreOutcome | null> {
  const artifact = await backupArtifact(db, blobs, opts.id);
  if (artifact === null) return null;
  const { id: _id, ...rest } = opts;
  return restoreArtifact(db, { ...rest, text: artifact.text, blobs });
}
