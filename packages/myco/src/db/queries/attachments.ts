/**
 * Attachment CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting an attachment. */
export interface AttachmentInsert {
  id: string;
  session_id: string;
  prompt_batch_id?: number;
  file_path: string;
  media_type?: string;
  description?: string;
  data?: Buffer;
  content_hash?: string;
  created_at: number;
}

/** Row shape returned from attachment queries (all columns, including BLOB). */
export interface AttachmentRow {
  id: string;
  session_id: string;
  prompt_batch_id: number | null;
  file_path: string;
  media_type: string | null;
  description: string | null;
  data: Buffer | null;
  content_hash: string | null;
  created_at: number;
}

/**
 * Row shape returned by list queries — excludes the `data` BLOB column.
 * Use this type when you only need metadata (e.g. listing attachments for a session).
 * The full row (including binary data) is only fetched by getAttachmentByFilePath.
 */
export type AttachmentListRow = Omit<AttachmentRow, 'data'>;

// ---------------------------------------------------------------------------
// Column lists
// ---------------------------------------------------------------------------

const ATTACHMENT_COLUMNS = [
  'id',
  'session_id',
  'prompt_batch_id',
  'file_path',
  'media_type',
  'description',
  'data',
  'content_hash',
  'created_at',
] as const;

/** Column list that omits the `data` BLOB — used by list queries to avoid loading megabytes of binary data. */
const ATTACHMENT_LIST_COLUMNS = [
  'id',
  'session_id',
  'prompt_batch_id',
  'file_path',
  'media_type',
  'description',
  'content_hash',
  'created_at',
] as const;

const SELECT_COLUMNS = ATTACHMENT_COLUMNS.join(', ');
const SELECT_LIST_COLUMNS = ATTACHMENT_LIST_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize shared metadata fields from a SQLite result row. */
function toAttachmentBase(row: Record<string, unknown>): AttachmentListRow {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    prompt_batch_id: (row.prompt_batch_id as number) ?? null,
    file_path: row.file_path as string,
    media_type: (row.media_type as string) ?? null,
    description: (row.description as string) ?? null,
    content_hash: (row.content_hash as string) ?? null,
    created_at: row.created_at as number,
  };
}

/** Normalize a SQLite result row into a typed AttachmentRow (includes BLOB). */
function toAttachmentRow(row: Record<string, unknown>): AttachmentRow {
  return { ...toAttachmentBase(row), data: (row.data as Buffer) ?? null };
}

/** Normalize a SQLite result row into a typed AttachmentListRow (no BLOB). */
function toAttachmentListRow(row: Record<string, unknown>): AttachmentListRow {
  return toAttachmentBase(row);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert an attachment record.
 *
 * Idempotent — ON CONFLICT (id) DO NOTHING means a second insert with the
 * same id silently succeeds without duplicating the row.
 *
 * @returns the inserted row, or undefined if the id already existed.
 */
export function insertAttachment(data: AttachmentInsert): AttachmentRow | undefined {
  const db = getDatabase();

  const info = db.prepare(
    `INSERT INTO attachments (${SELECT_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    data.id,
    data.session_id,
    data.prompt_batch_id ?? null,
    data.file_path,
    data.media_type ?? null,
    data.description ?? null,
    data.data ?? null,
    data.content_hash ?? null,
    data.created_at,
  );

  if (info.changes === 0) return undefined;

  return toAttachmentRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM attachments WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );
}

/**
 * List all attachments for a given session, ordered by created_at ASC.
 *
 * The `data` BLOB column is intentionally excluded — use getAttachmentByFilePath
 * when you need the binary content (e.g. for the serving route).
 *
 * @returns array of attachment metadata rows (empty array if none exist).
 */
export function listAttachmentsBySession(sessionId: string): AttachmentListRow[] {
  const db = getDatabase();

  const rows = db.prepare(
    `SELECT ${SELECT_LIST_COLUMNS} FROM attachments WHERE session_id = ? ORDER BY created_at ASC`,
  ).all(sessionId) as Record<string, unknown>[];

  return rows.map(toAttachmentListRow);
}

/**
 * Find an attachment by its file_path.
 *
 * @returns the first matching attachment row, or null if none exists.
 */
export function getAttachmentByFilePath(filePath: string): AttachmentRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM attachments WHERE file_path = ? LIMIT 1`,
  ).get(filePath) as Record<string, unknown> | undefined;

  return row ? toAttachmentRow(row) : null;
}
