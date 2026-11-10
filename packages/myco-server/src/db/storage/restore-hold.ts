import type { RelationalStore } from '../../core/adapters.js';
import { commit, write } from '../index.js';

/** A restore holds the artifact it applies under one progress row per artifact named `<phase>:<sha256>`, `next_row=1` once it has finished. */
export const RESTORE_HOLD_PHASE = 'extraction-session-counters';

const hold = write<[string]>({ name: 'backups.holdForRestore', sql: `INSERT INTO backup_restore_progress(table_name,artifact_hash,next_row)
  VALUES('${RESTORE_HOLD_PHASE}:'||?1,?1,0) ON CONFLICT(table_name) DO UPDATE SET next_row=0` });
const release = write<[string]>({ name: 'backups.releaseAfterRestore', sql: `UPDATE backup_restore_progress SET next_row=1
  WHERE table_name='${RESTORE_HOLD_PHASE}:'||?1 AND artifact_hash=?1` });

/** Retention keeps the artifact with this digest while its restore runs. */
export async function holdArtifactForRestore(db: RelationalStore, sha256: string): Promise<void> {
  await commit(db, hold.bind(sha256));
}

/** The restore of the artifact with this digest finished; retention may remove it again. */
export async function releaseArtifactAfterRestore(db: RelationalStore, sha256: string): Promise<void> {
  await commit(db, release.bind(sha256));
}
