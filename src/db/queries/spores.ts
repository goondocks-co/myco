/**
 * Spore CRUD query helpers.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of spores returned by listSpores when no limit given. */
const DEFAULT_LIST_LIMIT = 100;

/** Default spore status for new spores. */
const DEFAULT_STATUS = 'active';

/** Default importance score for new spores. */
export const DEFAULT_IMPORTANCE = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting a spore. */
export interface SporeInsert {
  id: string;
  curator_id: string;
  observation_type: string;
  content: string;
  created_at: number;
  session_id?: string | null;
  prompt_batch_id?: number | null;
  status?: string;
  context?: string | null;
  importance?: number;
  file_path?: string | null;
  tags?: string | null;
  content_hash?: string | null;
  updated_at?: number | null;
}

/** Row shape returned from spore queries (all columns, no embedding). */
export interface SporeRow {
  id: string;
  curator_id: string;
  session_id: string | null;
  prompt_batch_id: number | null;
  observation_type: string;
  status: string;
  content: string;
  context: string | null;
  importance: number;
  file_path: string | null;
  tags: string | null;
  content_hash: string | null;
  created_at: number;
  updated_at: number | null;
}

/** Filter options for `listSpores`. */
export interface ListSporesOptions {
  curator_id?: string;
  observation_type?: string;
  status?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Column list (excludes embedding — not useful in CRUD results)
// ---------------------------------------------------------------------------

const SPORE_COLUMNS = [
  'id',
  'curator_id',
  'session_id',
  'prompt_batch_id',
  'observation_type',
  'status',
  'content',
  'context',
  'importance',
  'file_path',
  'tags',
  'content_hash',
  'created_at',
  'updated_at',
] as const;

const SELECT_COLUMNS = SPORE_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed SporeRow. */
function toSporeRow(row: Record<string, unknown>): SporeRow {
  return {
    id: row.id as string,
    curator_id: row.curator_id as string,
    session_id: (row.session_id as string) ?? null,
    prompt_batch_id: (row.prompt_batch_id as number) ?? null,
    observation_type: row.observation_type as string,
    status: row.status as string,
    content: row.content as string,
    context: (row.context as string) ?? null,
    importance: row.importance as number,
    file_path: (row.file_path as string) ?? null,
    tags: (row.tags as string) ?? null,
    content_hash: (row.content_hash as string) ?? null,
    created_at: row.created_at as number,
    updated_at: (row.updated_at as number) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new spore.
 *
 * Requires a valid `curator_id` (foreign key to curators table).
 */
export async function insertSpore(data: SporeInsert): Promise<SporeRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO spores (
       id, curator_id, session_id, prompt_batch_id,
       observation_type, status, content, context,
       importance, file_path, tags, content_hash,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11, $12,
       $13, $14
     )
     RETURNING ${SELECT_COLUMNS}`,
    [
      data.id,
      data.curator_id,
      data.session_id ?? null,
      data.prompt_batch_id ?? null,
      data.observation_type,
      data.status ?? DEFAULT_STATUS,
      data.content,
      data.context ?? null,
      data.importance ?? DEFAULT_IMPORTANCE,
      data.file_path ?? null,
      data.tags ?? null,
      data.content_hash ?? null,
      data.created_at,
      data.updated_at ?? null,
    ],
  );

  return toSporeRow(result.rows[0] as Record<string, unknown>);
}

/**
 * Retrieve a single spore by id.
 *
 * @returns the spore row, or null if not found.
 */
export async function getSpore(id: string): Promise<SporeRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM spores WHERE id = $1`,
    [id],
  );

  if (result.rows.length === 0) return null;
  return toSporeRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List spores with optional filters, ordered by created_at DESC.
 */
export async function listSpores(
  options: ListSporesOptions = {},
): Promise<SporeRow[]> {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.curator_id !== undefined) {
    conditions.push(`curator_id = $${paramIndex++}`);
    params.push(options.curator_id);
  }

  if (options.observation_type !== undefined) {
    conditions.push(`observation_type = $${paramIndex++}`);
    params.push(options.observation_type);
  }

  if (options.status !== undefined) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(options.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;

  params.push(limit);

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM spores
     ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIndex}`,
    params,
  );

  return (result.rows as Record<string, unknown>[]).map(toSporeRow);
}

/**
 * Update the status and updated_at timestamp of a spore.
 *
 * @returns the updated row, or null if the spore does not exist.
 */
export async function updateSporeStatus(
  id: string,
  status: string,
  updatedAt: number,
): Promise<SporeRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `UPDATE spores
     SET status = $1, updated_at = $2
     WHERE id = $3
     RETURNING ${SELECT_COLUMNS}`,
    [status, updatedAt, id],
  );

  if (result.rows.length === 0) return null;
  return toSporeRow(result.rows[0] as Record<string, unknown>);
}
