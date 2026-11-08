import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { blobObjectKeySql } from '../../core/blob-objects.js';
import { TOKEN_LIVE } from '../../ingest/live-credential.js';
import { commit, read, write } from '../index.js';
import { prepareBound } from '../kernel/statement.js';
import { objectJournalSql } from './object-journal.js';
const journal = write<[token: string, now: number]>({ name: 'storage.expireCredentialUploads', sql:
  objectJournalSql(`SELECT ${blobObjectKeySql('r.project_id','r.key','r.reservation_id')},'upload',?2
    FROM blob_reservations r WHERE token_id=?1 AND expires_at<=?2`) });
const expire = write<[token: string, now: number]>({ name: 'storage.consumeCredentialUploads', sql:
  'DELETE FROM blob_reservations WHERE token_id=? AND expires_at<=?' });
const reserve = write<[id: string, project: string, key: string, token: string, size: number, expires: number, liveToken: string], { reservation_id: string }>({
  name: 'storage.admitBlobUpload', sql: `INSERT INTO blob_reservations(reservation_id,project_id,key,token_id,size,expires_at)
    SELECT ?,?,?,?,?,? WHERE ${TOKEN_LIVE} RETURNING reservation_id` });
const resize = write<[size: number, expires: number, id: string, token: string], { reservation_id: string }>({ name: 'storage.reconcileBlobUpload', sql:
  `UPDATE blob_reservations SET size=?,expires_at=? WHERE reservation_id=? AND ${TOKEN_LIVE} RETURNING reservation_id` });
const held = read<[id: string], { reservation_id: string }>({ name: 'storage.blobAuthority', sql:
  'SELECT reservation_id FROM blob_reservations WHERE reservation_id=?' });
export async function admitBlobUpload(db: RelationalStore, id: string, project: string, key: string, token: string,
  size: number, expires: number, now: number) {
  const [,,result] = await commit(db,journal.bind(token,now),expire.bind(token,now),
    reserve.bind(id,project,key,token,size,expires,token));
  return result.results.length===1;
}
export async function reconcileBlobUpload(db: RelationalStore, size: number, expires: number, id: string, token: string) {
  const [changed,current] = await commit(db,resize.bind(size,expires,id,token),held.bind(id));
  return changed.results.length===1 ? 'held' : current.results.length===0 ? 'consumed' : 'revoked';
}

const unpublished = write<[physical: string, at: number, reservation: string, project: string, key: string]>({ name: 'storage.journalUnpublishedUpload', sql:
  objectJournalSql(`SELECT ?1,'upload',?2 WHERE EXISTS(SELECT 1 FROM blob_reservations WHERE reservation_id=?3)
    AND (NOT EXISTS(SELECT 1 FROM blob_reservations WHERE reservation_id=?3 AND expires_at>?2) OR EXISTS(SELECT 1 FROM blobs WHERE project_id=?4 AND key=?5))`) });

/** Journals an uploaded object its publication batch will not register: the authority lapsed, or the key is already registered. */
export function journalUnpublishedUpload(db: RelationalStore, physical: string, at: number, reservation: string, project: string, key: string): PreparedStatement {
  return prepareBound(db, unpublished.bind(physical, at, reservation, project, key));
}
