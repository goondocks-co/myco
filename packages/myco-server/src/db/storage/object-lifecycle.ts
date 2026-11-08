import { objectJournalSql as journalSql } from './object-journal.js';
import { OBJECT_PUT_IN_FLIGHT_MS } from '../../constants.js';
import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { blobObjectKeySql } from '../../core/blob-objects.js';
import { assertion, commit, read, readSet, write } from '../index.js';
import { prepareBound } from '../kernel/statement.js';

export const RELEASE_RETRY_BASE_MS = 30_000;
export const RELEASE_RETRY_MAX_MS = 60 * 60 * 1000;
const MAX_RETRY_EXPONENT = Math.ceil(Math.log2(RELEASE_RETRY_MAX_MS / RELEASE_RETRY_BASE_MS));
const registered = (alias: string) => `EXISTS(SELECT 1 FROM blobs b WHERE b.project_id=${alias}.project_id AND b.key=${alias}.key AND b.generation=${alias}.generation) OR EXISTS(SELECT 1 FROM backups b INDEXED BY idx_backups_key WHERE b.key=${alias}.physical)`;
const uploadPhysical = blobObjectKeySql('r.project_id','r.key','r.reservation_id');
const uploadIntentSql = (expiry: string, predicate: string, returning = false) =>
  `INSERT INTO object_settlement_intents(physical,kind,expires_at,project_id,key,generation) SELECT ${uploadPhysical},'upload',${expiry},project_id,key,reservation_id FROM blob_reservations r WHERE ${predicate} ${returning ? 'RETURNING physical' : 'ON CONFLICT(physical) DO NOTHING'}`;
const unowned = (alias: string) => `NOT (${registered(alias)}) AND NOT EXISTS(SELECT 1 FROM blob_reservations r WHERE r.reservation_id=${alias}.generation) AND NOT EXISTS(SELECT 1 FROM backup_publications p WHERE p.key=${alias}.physical)`;
const intent = write<[reservation: string, now: number], { physical: string }>({
  name: 'storage.beginObjectIntent', sql:
  uploadIntentSql('expires_at','reservation_id=? AND expires_at>?',true) });
const uploadAuthority = assertion<[reservation: string, now: number]>({ name: 'storage.uploadIntentAuthority', sql:
  `SELECT CASE WHEN EXISTS(SELECT 1 FROM blob_reservations WHERE reservation_id=? AND expires_at>?) THEN 1 ELSE json_extract('[]','$[upload_authority_expired]') END` });
const mark = write<[physical: string, at: number]>({ name: 'storage.settleObjectIntent', sql:
  'UPDATE object_settlement_intents SET expires_at=MAX(expires_at,?2) WHERE physical=?1' });
const settleJournal = write<[physical: string, at: number]>({ name: 'storage.journalSettledObject', sql:
  journalSql(`SELECT physical,kind,?2 FROM object_settlement_intents i WHERE physical=?1 AND NOT (${registered('i')})`) });
const clearSettled = write<[physical: string]>({ name: 'storage.clearSettledIntent', sql:
  'DELETE FROM object_settlement_intents WHERE physical=?' });
const due = read<[now: number, limit: number], { physical: string; attempts: number }>({ name: 'storage.dueObjectReleases', sql:
  'SELECT physical,attempts FROM object_releases WHERE retry_at<=? ORDER BY retry_at,created_at,physical LIMIT ?' });
const acknowledge = write<[physical: string], { physical: string }>({ name: 'storage.acknowledgeObjectRelease', sql:
  'DELETE FROM object_releases WHERE physical=? RETURNING physical' });
const retireAcknowledged = write<[physical: string, issued: number, grace: number]>({ name: 'storage.retireAcknowledgedIntent', sql:
  `DELETE FROM object_settlement_intents AS i WHERE physical=?1 AND expires_at+?3<=?2 AND EXISTS(SELECT 1 FROM object_releases r WHERE r.physical=i.physical) AND ${unowned('i')}` });
const retry = write<[physical: string, at: number, attempts: number]>({ name: 'storage.retryObjectRelease', sql:
  'UPDATE object_releases SET retry_at=MAX(retry_at,?2),attempts=MAX(attempts,?3) WHERE physical=?1' });

const expiredUploads = `SELECT reservation_id FROM blob_reservations WHERE expires_at<=?1 ORDER BY expires_at,reservation_id LIMIT ?2`;
const expiredBackups = `SELECT key FROM backup_publications WHERE expires_at<=?1 ORDER BY expires_at,key LIMIT ?2`;
const expiredIntents = write<[now: number, limit: number]>({ name: 'storage.retainExpiredUploadIntents', sql:
  uploadIntentSql('MAX(expires_at,?1)',`reservation_id IN (${expiredUploads})`) });
const journalUploads = write<[now: number, limit: number]>({ name: 'storage.journalExpiredUploads', sql:
  journalSql(`SELECT ${uploadPhysical},'upload',?1 FROM blob_reservations r WHERE reservation_id IN (${expiredUploads})`) });
const consumeUploads = write<[now: number, limit: number], { reservation_id: string }>({ name: 'storage.consumeExpiredUploads', sql:
  `DELETE FROM blob_reservations WHERE reservation_id IN (${expiredUploads}) RETURNING reservation_id` });
const journalBackups = write<[now: number, limit: number]>({ name: 'storage.journalExpiredBackups', sql:
  journalSql(`SELECT key,'backup',?1 FROM backup_publications p WHERE key IN (${expiredBackups}) AND NOT EXISTS(SELECT 1 FROM backups b WHERE b.key=p.key)`) });
const consumeBackups = write<[now: number, limit: number], { key: string }>({ name: 'storage.consumeExpiredBackups', sql:
  `DELETE FROM backup_publications WHERE key IN (${expiredBackups}) RETURNING key` });
const cursorPage = read<[now: number, limit: number, grace: number], { cursor: string; page: string }>({ name: 'storage.reconciliationPage', sql:
  `SELECT physical AS cursor,(SELECT json_group_array(physical) FROM ( SELECT physical FROM object_settlement_intents i WHERE (expires_at+?3<=?1 OR (${registered('i')})) AND physical>c.physical ORDER BY physical LIMIT ?2)) AS page FROM object_reconciliation_cursor c WHERE slot=1` });
const cursorHeld = assertion<[cursor: string]>({ name: 'storage.reconciliationCursorHeld', sql:
  `SELECT CASE WHEN EXISTS(SELECT 1 FROM object_reconciliation_cursor WHERE slot=1 AND physical=?) THEN 1 ELSE json_extract('[]','$[object_reconciliation_conflict]') END` });
const reconcile = write<[page: string, now: number]>({ name: 'storage.reconcileObjectIntents', sql:
  journalSql(`SELECT physical,kind,?2 FROM object_settlement_intents i WHERE physical IN (SELECT value FROM json_each(?1)) AND expires_at<=?2 AND ${unowned('i')}`) });
const retireRegistered = write<[page: string]>({ name: 'storage.retireRegisteredIntents', sql:
  `DELETE FROM object_settlement_intents AS i WHERE physical IN (SELECT value FROM json_each(?1)) AND (${registered('i')})` });
const advance = write<[physical: string]>({ name: 'storage.advanceObjectReconciliation', sql:
  'UPDATE object_reconciliation_cursor SET physical=? WHERE slot=1' });

export async function beginUploadIntent(db: RelationalStore, reservation: string, now: number): Promise<string> {
  const [,result] = await commit(db,uploadAuthority.bind(reservation,now),intent.bind(reservation,now));
  const row = result.results[0];
  if (row === undefined) throw new Error('upload settlement intent returned no physical key');
  return row.physical;
}
/** An unresolved PUT retains its intent through its in-flight grace window. */
export async function settleObjectIntent(db: RelationalStore, physical: string, now: number, settled: boolean) {
  await commit(db,mark.bind(physical,now),settleJournal.bind(physical,now),...(settled ? [clearSettled.bind(physical)] : []));
}
export async function reconcileObjectIntents(db: RelationalStore, now: number, limit: number) {
  const [[row]] = await readSet(db,cursorPage.bind(now,limit,OBJECT_PUT_IN_FLIGHT_MS));
  if (row === undefined) throw new Error('object reconciliation cursor is missing');
  const page = JSON.parse(row.page) as string[];
  await commit(db,cursorHeld.bind(row.cursor),retireRegistered.bind(row.page),reconcile.bind(row.page,now),
    advance.bind(page.at(-1) ?? ''));
}
export async function drainAuthorities(db: RelationalStore, now: number, limit: number) {
  const [,,uploads,,backups] = await commit(db,expiredIntents.bind(now,limit),journalUploads.bind(now,limit),consumeUploads.bind(now,limit),
    journalBackups.bind(now,limit),consumeBackups.bind(now,limit));
  return uploads.results.length+backups.results.length;
}
export async function dueObjectReleases(db: RelationalStore, now: number, limit: number) {
  const [rows] = await readSet(db,due.bind(now,limit)); return rows;
}
export async function acknowledgeRelease(db: RelationalStore, physical: string, issuedAt: number) {
  const [,removed]=await commit(db,retireAcknowledged.bind(physical,issuedAt,OBJECT_PUT_IN_FLIGHT_MS),acknowledge.bind(physical));
  return removed.results.length;
}
export async function retryRelease(db: RelationalStore, physical: string, now: number, attempts: number) {
  const delay = Math.min(RELEASE_RETRY_MAX_MS,RELEASE_RETRY_BASE_MS*2**Math.min(attempts,MAX_RETRY_EXPONENT));
  await commit(db,retry.bind(physical,now+delay,attempts+1));
}

const resetHolds = write<[]>({ name: 'storage.resetRecoveryHolds', sql: 'DELETE FROM recovery_holds' });
const resetJournal = write<[]>({ name: 'storage.resetObjectReleases', sql: 'DELETE FROM object_releases' });
const resetUploads = write<[]>({ name: 'storage.resetUploadAuthorities', sql: 'DELETE FROM blob_reservations' });
const resetBackups = write<[]>({ name: 'storage.resetBackupPublications', sql: 'DELETE FROM backup_publications' });
const resetCandidates = write<[]>({ name: 'storage.resetBackupCandidates', sql: 'DELETE FROM backup_release_candidates' });
const resetIntents = write<[]>({ name: 'storage.resetObjectIntents', sql: 'DELETE FROM object_settlement_intents' });
export async function resetObjectLifecycle(db: RelationalStore) {
  await commit(db,resetHolds.bind(),resetJournal.bind(),resetUploads.bind(),resetBackups.bind(),
    resetCandidates.bind(),resetIntents.bind(),advance.bind(''));
}

const retainedAuthority = write<[reservation: string, now: number]>({ name: 'storage.retainConsumedUploadIntent', sql:
  uploadIntentSql('MAX(expires_at,?2)','reservation_id=?1') });
const releasedAuthority = write<[reservation: string, now: number]>({ name: 'storage.journalConsumedUpload', sql:
  journalSql(`SELECT ${uploadPhysical},'upload',?2 FROM blob_reservations r WHERE reservation_id=?1`) });
const removedAuthority = write<[reservation: string]>({ name: 'storage.removeUploadAuthority', sql:
  'DELETE FROM blob_reservations WHERE reservation_id=?' });
const uploadAuthorityBindings = (reservation: string, now: number) =>
  [retainedAuthority.bind(reservation,now),releasedAuthority.bind(reservation,now),removedAuthority.bind(reservation)] as const;

/** Composes authority consumption into a caller's publication batch. */
export function consumeUploadAuthority(db: RelationalStore, reservation: string, now: number): PreparedStatement[] {
  return uploadAuthorityBindings(reservation,now).map(bound=>prepareBound(db,bound));
}
export async function consumeUpload(db: RelationalStore, reservation: string, now: number) {
  await commit(db,...uploadAuthorityBindings(reservation,now));
}
export async function discardUnissuedUpload(db: RelationalStore, reservation: string) {
  await commit(db,removedAuthority.bind(reservation));
}
