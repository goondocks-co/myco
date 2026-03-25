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
  created_at: number;
}

/** Row shape returned from attachment queries (all columns). */
export interface AttachmentRow {
  id: string;
  session_id: string;
  prompt_batch_id: number | null;
  file_path: string;
  media_type: string | null;
  description: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const ATTACHMENT_COLUMNS = [
  'id',
  'session_id',
  'prompt_batch_id',
  'file_path',
  'media_type',
  'description',
  'created_at',
] as const;

const SELECT_COLUMNS = ATTACHMENT_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed AttachmentRow. */
function toAttachmentRow(row: Record<string, unknown>): AttachmentRow {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    prompt_batch_id: (row.prompt_batch_id as number) ?? null,
    file_path: row.file_path as string,
    media_type: (row.media_type as string) ?? null,
    description: (row.description as string) ?? null,
    created_at: row.created_at as number,
  };
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
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    data.id,
    data.session_id,
    data.prompt_batch_id ?? null,
    data.file_path,
    data.media_type ?? null,
    data.description ?? null,
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
 * @returns array of attachment rows (empty array if none exist).
 */
export function listAttachmentsBySession(sessionId: string): AttachmentRow[] {
  const db = getDatabase();

  const rows = db.prepare(
    'SELECT * FROM attachments WHERE session_id = ? ORDER BY created_at ASC',
  ).all(sessionId) as Record<string, unknown>[];

  return rows.map(toAttachmentRow);
}
