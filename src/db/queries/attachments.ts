/**
 * Attachment CRUD query helpers.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
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
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed AttachmentRow. */
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
export async function insertAttachment(data: AttachmentInsert): Promise<AttachmentRow | undefined> {
  const db = getDatabase();
  const result = await db.query(
    `INSERT INTO attachments (id, session_id, prompt_batch_id, file_path, media_type, description, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [
      data.id,
      data.session_id,
      data.prompt_batch_id ?? null,
      data.file_path,
      data.media_type ?? null,
      data.description ?? null,
      data.created_at,
    ],
  );
  if (result.rows.length === 0) return undefined;
  return toAttachmentRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List all attachments for a given session, ordered by created_at ASC.
 *
 * @returns array of attachment rows (empty array if none exist).
 */
export async function listAttachmentsBySession(sessionId: string): Promise<AttachmentRow[]> {
  const db = getDatabase();
  const result = await db.query(
    'SELECT * FROM attachments WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId],
  );
  return (result.rows as Record<string, unknown>[]).map(toAttachmentRow);
}
