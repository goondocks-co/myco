import { objectJournalSql } from './object-journal.js';
import type { RelationalStore } from '../../core/adapters.js';
import type { BackupIndexRow } from '../../core/backup.js';
import { assertion, commit, read, readSet, write } from '../index.js';
const begin = write<[key: string, expires: number]>({ name: 'storage.beginBackupPublication', sql:
  'INSERT INTO backup_publications(key,expires_at) VALUES(?,?)' });
const intent = write<[key: string, expires: number]>({ name: 'storage.beginBackupPublicationIntent', sql:
  "INSERT INTO object_settlement_intents(physical,kind,expires_at) VALUES(?,'backup',?)" });
const live = assertion<[key: string, now: number]>({ name: 'storage.backupPublicationLive', sql:
  `SELECT CASE WHEN EXISTS(SELECT 1 FROM backup_publications WHERE key=? AND expires_at>?)
    THEN 1 ELSE json_extract('[]','$[backup_publication_expired]') END` });
const publish = write<[id: string, key: string, at: number, size: number, counts: string, schema: number, producer: string, digest: string | null], { id: string }>({
  name: 'storage.publishBackup', sql: `INSERT INTO backups(id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned,sha256)
    VALUES(?,?,?,?,?,?,?,0,?) RETURNING id` });
const consume = write<[key: string]>({ name: 'storage.consumeBackupPublication', sql: 'DELETE FROM backup_publications WHERE key=?' });
const journal = write<[key: string, now: number]>({ name: 'storage.journalBackupPublication', sql:
  objectJournalSql(`SELECT ?1,'backup',?2 WHERE NOT EXISTS(SELECT 1 FROM backups WHERE key=?1)`) });
export async function beginBackupPublication(db: RelationalStore, key: string, expires: number) {
  await commit(db,begin.bind(key,expires),intent.bind(key,expires));
}
export async function publishBackup(db: RelationalStore, row: BackupIndexRow, now: number) {
  await commit(db,live.bind(row.key,now),
    publish.bind(row.id,row.key,row.created_at,row.size_bytes,row.counts_json,row.schema_version,row.producer,row.sha256),
    consume.bind(row.key));
}
export async function abandonBackupPublication(db: RelationalStore, key: string, now: number) {
  await commit(db,journal.bind(key,now),consume.bind(key));
}

const registered = read<[key: string], unknown>({ name: 'storage.backupObjectRegistered', sql:
  'SELECT 1 FROM backups WHERE key=?' });
export async function backupObjectRegistered(db: RelationalStore, key: string): Promise<boolean> {
  const [rows] = await readSet(db,registered.bind(key));
  return rows.length>0;
}
