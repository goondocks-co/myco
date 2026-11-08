import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, readSet, write } from '../index.js';

export type BackupPruneOutcome = (
  | { state: 'pruned'; pruned: number; deferred: number }
  | { state: 'changed'; reason: 'retention_changed' }
  | { state: 'failed'; errorClass: string }
) & { recordingErrorClass?: string };
export interface BackupPruneStatus { at: number; outcome: BackupPruneOutcome }
const key = 'backup_prune_outcome';
const put = write<[value: string]>({ name: 'meta.backupPruneOutcome', sql:
  `INSERT OR REPLACE INTO schema_meta(key,value) VALUES('${key}',?)` });
const get = read<[], { value: string }>({ name: 'meta.readBackupPruneOutcome', sql:
  `SELECT value FROM schema_meta WHERE key='${key}'` });
export async function recordBackupPrune(db: RelationalStore, at: number, outcome: BackupPruneOutcome) {
  await commit(db,put.bind(JSON.stringify({at,outcome})));
}
export async function backupPruneStatus(db: RelationalStore): Promise<BackupPruneStatus | null> {
  const [[row]] = await readSet(db,get.bind());
  return row === undefined ? null : JSON.parse(row.value) as BackupPruneStatus;
}
