import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, readSet, write } from '../index.js';

export type BackupPruneOutcome = (
  | { state: 'pruned'; pruned: number; deferred: number; remaining?: true }
  | { state: 'deferred'; reason: 'building' }
  | { state: 'changed'; reason: 'retention_changed' }
  | { state: 'failed'; errorClass: string }
) & { recordingErrorClass?: string };
export interface BackupPruneStatus {
  at: number;
  outcome: BackupPruneOutcome;
  /** The most recent failed pass, held until a pass finishes the work, so the next wake's progress cannot hide it. */
  lastFailure?: { at: number; errorClass: string };
}
const key = 'backup_prune_outcome';
const failureKey = 'backup_prune_last_failure';
const put = write<[value: string]>({ name: 'meta.backupPruneOutcome', sql:
  `INSERT OR REPLACE INTO schema_meta(key,value) VALUES('${key}',?1)` });
const putFailure = write<[value: string]>({ name: 'meta.backupPruneLastFailure', sql:
  `INSERT OR REPLACE INTO schema_meta(key,value) VALUES('${failureKey}',?1)` });
const clearFailure = write<[]>({ name: 'meta.clearBackupPruneLastFailure', sql:
  `DELETE FROM schema_meta WHERE key='${failureKey}'` });
const get = read<[], { key: string; value: string }>({ name: 'meta.readBackupPruneOutcome', sql:
  `SELECT key,value FROM schema_meta WHERE key IN ('${key}','${failureKey}')` });

const finished = (outcome: BackupPruneOutcome) => outcome.state === 'pruned' && outcome.deferred === 0 && outcome.remaining !== true;

export async function recordBackupPrune(db: RelationalStore, at: number, outcome: BackupPruneOutcome) {
  const failure = outcome.state === 'failed' ? [putFailure.bind(JSON.stringify({ at, errorClass: outcome.errorClass }))]
    : finished(outcome) ? [clearFailure.bind()] : [];
  await commit(db, put.bind(JSON.stringify({ at, outcome })), ...failure);
}

export async function backupPruneStatus(db: RelationalStore): Promise<BackupPruneStatus | null> {
  const [rows] = await readSet(db, get.bind());
  const stored = new Map(rows.map(row => [row.key, row.value]));
  const status = stored.get(key);
  if (status === undefined) return null;
  const failure = stored.get(failureKey);
  return { ...JSON.parse(status) as BackupPruneStatus, ...(failure === undefined ? {} : { lastFailure: JSON.parse(failure) as NonNullable<BackupPruneStatus['lastFailure']> }) };
}
