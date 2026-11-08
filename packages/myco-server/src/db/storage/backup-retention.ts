import { objectJournalSql } from './object-journal.js';
import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commit, read, readSet, write, type Bound } from '../index.js';

export interface RetentionIndexRow { id: string; key: string; created_at: number; pinned: number }
export interface RetentionObservation { rows: RetentionIndexRow[]; policyAssertion: Bound }
const indexSql = 'SELECT id,key,created_at,pinned FROM backups ORDER BY id';
const observation = read<[], RetentionIndexRow>({ name: 'storage.retentionObservation', sql: indexSql });
const unchanged = assertion<[rows: string]>({ name: 'storage.retentionUnchanged', sql:
  `SELECT CASE WHEN
    ?=(SELECT json_group_array(json_object('id',id,'key',key,'created_at',created_at,'pinned',pinned)) FROM (${indexSql}))
    THEN 1 ELSE json_extract('[]','$[backup_retention_conflict]') END` });
const candidates = write<[at: number, ids: string]>({ name: 'storage.backupCandidates', sql:
  `INSERT INTO backup_release_candidates(id,created_at) SELECT value,?1 FROM json_each(?2) WHERE value IS NOT NULL
    ON CONFLICT(id) DO NOTHING` });
const journal = write<[at: number, ids: string, victims: string], { physical: string }>({ name: 'storage.releaseBackupObjects', sql:
  objectJournalSql(`SELECT bk.key,'backup',?1 FROM backups bk
    WHERE bk.id IN (SELECT value FROM json_each(?2)) AND bk.id IN (SELECT value FROM json_each(?3))
      AND bk.pinned=0 AND NOT EXISTS(SELECT 1 FROM recovery_holds WHERE released_at IS NULL)
      AND EXISTS(SELECT 1 FROM backup_release_candidates rc WHERE rc.id=bk.id)
    `) + ' RETURNING physical' });
const remove = write<[ids: string, victims: string], { id: string }>({ name: 'storage.removeReleasedBackups', sql:
  `DELETE FROM backups WHERE id IN (SELECT value FROM json_each(?1)) AND id IN (SELECT value FROM json_each(?2))
    AND pinned=0 AND NOT EXISTS(SELECT 1 FROM recovery_holds WHERE released_at IS NULL)
    AND EXISTS(SELECT 1 FROM object_releases r WHERE r.physical=backups.key) RETURNING id` });
const clear = write<[ids: string]>({ name: 'storage.clearBackupCandidates', sql:
  `DELETE FROM backup_release_candidates WHERE id IN (SELECT value FROM json_each(?))
    AND NOT EXISTS(SELECT 1 FROM recovery_holds WHERE released_at IS NULL)` });
const held = read<[ids: string], { held: number }>({ name: 'storage.heldBackupCandidates', sql:
  'SELECT COUNT(*) AS held FROM backup_release_candidates WHERE id IN (SELECT value FROM json_each(?))' });
export async function readRetentionIndex(db: RelationalStore): Promise<RetentionIndexRow[]> {
  const [rows] = await readSet(db,observation.bind());
  return rows;
}
export async function commitBackupRelease(db: RelationalStore, ids: readonly string[], victims: ReadonlySet<string>,
  observed: RetentionObservation, now: number) {
  const page = JSON.stringify(ids);
  const [, , , , removed, , remaining] = await commit(db,
    observed.policyAssertion, unchanged.bind(JSON.stringify(observed.rows)),
    candidates.bind(now,page), journal.bind(now,page,JSON.stringify([...victims])),
    remove.bind(page,JSON.stringify([...victims])), clear.bind(page), held.bind(page));
  return { released: removed.results.length, deferred: remaining.results[0]!.held };
}
