import type { RelationalStore } from '../../core/adapters.js';
import type { BackupIndexRow } from '../../core/backup.js';
import { first, read, rows } from '../index.js';

export const BACKUP_LIST_LIMIT = 50;
export const BACKUP_LIST_MAX = 100;

export type BackupVerificationState = 'unverified' | 'verified' | 'failed';
export type BackupVerificationDetail = 'absent' | 'size' | 'sha256';
export interface BackupVerification {
  state: BackupVerificationState;
  checkedAt: number | null;
  detail: BackupVerificationDetail | null;
}
export type ListedBackup = BackupIndexRow & { verification: BackupVerification };

interface ListRow extends BackupIndexRow {
  verification_state: 'verified' | 'failed' | null;
  verification_checked_at: number | null;
  verification_detail: BackupVerificationDetail | null;
}
const COLUMNS = 'id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned,sha256,verification_state,verification_checked_at,verification_detail';
const firstPage = read<[limit: number], ListRow>({ name: 'storage.backupListFirst', sql:
  `SELECT ${COLUMNS} FROM backups ORDER BY created_at DESC,id DESC LIMIT ?1` });
const nextPage = read<[createdAt: number, id: string, limit: number], ListRow>({ name: 'storage.backupListNext', sql:
  `SELECT ${COLUMNS} FROM backups WHERE (created_at,id)<(?1,?2) ORDER BY created_at DESC,id DESC LIMIT ?3` });

const CURSOR_PREFIX = 'b1:';
const encodeCursor = (row: Pick<BackupIndexRow, 'created_at' | 'id'>) => `${CURSOR_PREFIX}${row.created_at}:${encodeURIComponent(row.id)}`;

/** The position a cursor names, or null when the text is not one this server wrote. */
export function decodeBackupCursor(text: string): { createdAt: number; id: string } | null {
  if (!text.startsWith(CURSOR_PREFIX)) return null;
  const rest = text.slice(CURSOR_PREFIX.length);
  const split = rest.indexOf(':');
  const createdAt = Number(rest.slice(0, split));
  if (split < 1 || !Number.isSafeInteger(createdAt)) return null;
  try { return { createdAt, id: decodeURIComponent(rest.slice(split + 1)) }; }
  catch { return null; }
}

const listed = ({ verification_state: state, verification_checked_at: checkedAt, verification_detail: detail, ...row }: ListRow): ListedBackup => ({
  ...row, verification: { state: state ?? 'unverified', checkedAt, detail },
});

/** One page of the catalogue, newest first. Whether an artifact's bytes are sound is the verification it last recorded, and its check time. */
export async function listBackupPage(db: RelationalStore, opts: { limit?: number; cursor?: string } = {}): Promise<{ backups: ListedBackup[]; cursor: string | null }> {
  const limit = Math.min(opts.limit ?? BACKUP_LIST_LIMIT, BACKUP_LIST_MAX);
  const position = opts.cursor === undefined ? null : decodeBackupCursor(opts.cursor);
  const fetched = await rows(db, position === null ? firstPage.bind(limit + 1) : nextPage.bind(position.createdAt, position.id, limit + 1));
  const page = fetched.slice(0, limit).map(listed);
  const last = page.at(-1);
  return { backups: page, cursor: fetched.length > limit && last !== undefined ? encodeCursor(last) : null };
}

const verificationRow = read<[id: string], BackupIndexRow>({ name: 'storage.backupVerificationRow', sql:
  'SELECT id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned,sha256 FROM backups WHERE id=?1' });
export async function readBackupRow(db: RelationalStore, id: string): Promise<BackupIndexRow | null> {
  return first(db, verificationRow.bind(id));
}
