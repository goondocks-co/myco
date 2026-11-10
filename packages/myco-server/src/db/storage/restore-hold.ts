import type { RelationalStore } from '../../core/adapters.js';
import { commit, write } from '../index.js';

/**
 * A restore holds the artifact it applies under one progress row per artifact named `<phase>:<sha256>`, `next_row=1`
 * once its last step, the documents and bundle settlement, has finished. A refused step keeps the hold until a retry of
 * the same artifact finishes. The hold is per artifact, not per restore: of two overlapping restores of one artifact,
 * the first to finish releases it for both, and a restore that fails and is never retried keeps its artifact from
 * retention until one is.
 */
export const RESTORE_HOLD_PHASE = 'extraction-session-counters';

const hold = write<[string]>({ name: 'backups.holdForRestore', sql: `INSERT INTO backup_restore_progress(table_name,artifact_hash,next_row)
  VALUES('${RESTORE_HOLD_PHASE}:'||?1,?1,0) ON CONFLICT(table_name) DO UPDATE SET next_row=0` });
const release = write<[string]>({ name: 'backups.releaseAfterRestore', sql: `UPDATE backup_restore_progress SET next_row=1
  WHERE table_name='${RESTORE_HOLD_PHASE}:'||?1 AND artifact_hash=?1` });

/** Retention keeps the artifact with this digest from now until a restore of it finishes. */
export async function holdArtifactForRestore(db: RelationalStore, sha256: string): Promise<void> {
  await commit(db, hold.bind(sha256));
}

/** A restore of the artifact with this digest finished every step; retention may remove it again. */
export async function releaseArtifactAfterRestore(db: RelationalStore, sha256: string): Promise<void> {
  await commit(db, release.bind(sha256));
}
