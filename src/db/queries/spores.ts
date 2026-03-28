/**
 * Spore CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { DEFAULT_MACHINE_ID } from '@myco/constants.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';

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
  agent_id: string;
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
  properties?: string | null;
  updated_at?: number | null;
  machine_id?: string;
}

/** Row shape returned from spore queries (all columns). */
export interface SporeRow {
  id: string;
  agent_id: string;
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
  properties: string | null;
  embedded: number;
  created_at: number;
  updated_at: number | null;
  machine_id: string;
  synced_at: number | null;
}

/** Filter options for `listSpores`. */
export interface ListSporesOptions {
  agent_id?: string;
  observation_type?: string;
  status?: string;
  session_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const SPORE_COLUMNS = [
  'id',
  'agent_id',
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
  'properties',
  'embedded',
  'created_at',
  'updated_at',
  'machine_id',
  'synced_at',
] as const;

const SELECT_COLUMNS = SPORE_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed SporeRow. */
function toSporeRow(row: Record<string, unknown>): SporeRow {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
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
    properties: (row.properties as string) ?? null,
    embedded: (row.embedded as number) ?? 0,
    created_at: row.created_at as number,
    updated_at: (row.updated_at as number) ?? null,
    machine_id: (row.machine_id as string) ?? DEFAULT_MACHINE_ID,
    synced_at: (row.synced_at as number) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new spore.
 *
 * Requires a valid `agent_id` (foreign key to agents table).
 */
export function insertSpore(data: SporeInsert): SporeRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO spores (
       id, agent_id, session_id, prompt_batch_id,
       observation_type, status, content, context,
       importance, file_path, tags, content_hash,
       properties, created_at, updated_at, machine_id
     ) VALUES (
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?
     )`,
  ).run(
    data.id,
    data.agent_id,
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
    data.properties ?? null,
    data.created_at,
    data.updated_at ?? null,
    data.machine_id ?? DEFAULT_MACHINE_ID,
  );

  const row = toSporeRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM spores WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );

  syncRow('spores', row);

  return row;
}

/**
 * Retrieve a single spore by id.
 *
 * @returns the spore row, or null if not found.
 */
export function getSpore(id: string): SporeRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM spores WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toSporeRow(row);
}

/**
 * List spores with optional filters, ordered by created_at DESC.
 */
/** Build WHERE clause and bound params from spore filter options. */
function buildSporeWhere(
  options: Omit<ListSporesOptions, 'limit' | 'offset'>,
): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.agent_id !== undefined) {
    conditions.push(`agent_id = ?`);
    params.push(options.agent_id);
  }
  if (options.observation_type !== undefined) {
    conditions.push(`observation_type = ?`);
    params.push(options.observation_type);
  }
  if (options.status !== undefined) {
    conditions.push(`status = ?`);
    params.push(options.status);
  }
  if (options.session_id !== undefined) {
    conditions.push(`session_id = ?`);
    params.push(options.session_id);
  }
  if (options.search !== undefined && options.search.length > 0) {
    conditions.push(`(content LIKE ? OR observation_type LIKE ?)`);
    const pattern = `%${options.search}%`;
    params.push(pattern, pattern);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * List spores with optional filters, ordered by created_at DESC.
 */
export function listSpores(
  options: ListSporesOptions = {},
): SporeRow[] {
  const db = getDatabase();
  const { where, params } = buildSporeWhere(options);
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const offset = options.offset ?? 0;

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM spores
     ${where}
     ORDER BY created_at DESC
     LIMIT ?
     OFFSET ?`,
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(toSporeRow);
}

/**
 * Count spores matching optional filters (for pagination totals).
 */
export function countSpores(
  options: Omit<ListSporesOptions, 'limit' | 'offset'> = {},
): number {
  const db = getDatabase();
  const { where, params } = buildSporeWhere(options);

  const row = db.prepare(
    `SELECT COUNT(*) as count FROM spores ${where}`,
  ).get(...params) as { count: number };

  return row.count;
}

/**
 * Update the status and updated_at timestamp of a spore.
 *
 * @returns the updated row, or null if the spore does not exist.
 */
export function updateSporeStatus(
  id: string,
  status: string,
  updatedAt: number,
): SporeRow | null {
  const db = getDatabase();

  const info = db.prepare(
    `UPDATE spores
     SET status = ?, updated_at = ?
     WHERE id = ?`,
  ).run(status, updatedAt, id);

  if (info.changes === 0) return null;

  const row = toSporeRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM spores WHERE id = ?`).get(id) as Record<string, unknown>,
  );

  syncRow('spores', row);

  return row;
}
