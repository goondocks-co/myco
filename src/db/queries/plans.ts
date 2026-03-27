/**
 * Plan CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of plans returned by listPlans when no limit given. */
const DEFAULT_LIST_LIMIT = 100;

/** Default plan status for new plans. */
const DEFAULT_STATUS = 'active';

/** Default processed flag for new plans. */
const DEFAULT_PROCESSED = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting/upserting a plan. */
export interface PlanInsert {
  id: string;
  created_at: number;
  status?: string;
  author?: string | null;
  title?: string | null;
  content?: string | null;
  source_path?: string | null;
  tags?: string | null;
  session_id?: string | null;
  prompt_batch_id?: number | null;
  content_hash?: string | null;
  processed?: number;
  updated_at?: number | null;
}

/** Row shape returned from plan queries. */
export interface PlanRow {
  id: string;
  status: string;
  author: string | null;
  title: string | null;
  content: string | null;
  source_path: string | null;
  tags: string | null;
  session_id: string | null;
  prompt_batch_id: number | null;
  content_hash: string | null;
  processed: number;
  embedded: number;
  created_at: number;
  updated_at: number | null;
}

/** Filter options for `listPlans`. */
export interface ListPlansOptions {
  status?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const PLAN_COLUMNS = [
  'id',
  'status',
  'author',
  'title',
  'content',
  'source_path',
  'tags',
  'session_id',
  'prompt_batch_id',
  'content_hash',
  'processed',
  'embedded',
  'created_at',
  'updated_at',
] as const;

const SELECT_COLUMNS = PLAN_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed PlanRow. */
function toPlanRow(row: Record<string, unknown>): PlanRow {
  return {
    id: row.id as string,
    status: row.status as string,
    author: (row.author as string) ?? null,
    title: (row.title as string) ?? null,
    content: (row.content as string) ?? null,
    source_path: (row.source_path as string) ?? null,
    tags: (row.tags as string) ?? null,
    session_id: (row.session_id as string) ?? null,
    prompt_batch_id: (row.prompt_batch_id as number) ?? null,
    content_hash: (row.content_hash as string) ?? null,
    processed: row.processed as number,
    embedded: (row.embedded as number) ?? 0,
    created_at: row.created_at as number,
    updated_at: (row.updated_at as number) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a plan or update it if the id already exists.
 *
 * On conflict the row is updated with the values from `data`.
 */
export function upsertPlan(data: PlanInsert): PlanRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO plans (
       id, status, author, title, content,
       source_path, tags, session_id, prompt_batch_id, content_hash,
       processed, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?
     )
     ON CONFLICT (id) DO UPDATE SET
       status          = EXCLUDED.status,
       author          = EXCLUDED.author,
       title           = EXCLUDED.title,
       content         = EXCLUDED.content,
       source_path     = EXCLUDED.source_path,
       tags            = EXCLUDED.tags,
       session_id      = EXCLUDED.session_id,
       prompt_batch_id = EXCLUDED.prompt_batch_id,
       content_hash    = EXCLUDED.content_hash,
       processed       = EXCLUDED.processed,
       updated_at      = EXCLUDED.updated_at,
       embedded        = CASE
         WHEN EXCLUDED.content_hash != plans.content_hash THEN 0
         ELSE plans.embedded
       END`,
  ).run(
    data.id,
    data.status ?? DEFAULT_STATUS,
    data.author ?? null,
    data.title ?? null,
    data.content ?? null,
    data.source_path ?? null,
    data.tags ?? null,
    data.session_id ?? null,
    data.prompt_batch_id ?? null,
    data.content_hash ?? null,
    data.processed ?? DEFAULT_PROCESSED,
    data.created_at,
    data.updated_at ?? null,
  );

  return toPlanRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM plans WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );
}

/**
 * Retrieve a single plan by id.
 *
 * @returns the plan row, or null if not found.
 */
export function getPlan(id: string): PlanRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM plans WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toPlanRow(row);
}

/**
 * List plans with optional filters, ordered by created_at DESC.
 */
export function listPlans(
  options: ListPlansOptions = {},
): PlanRow[] {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.status !== undefined) {
    conditions.push(`status = ?`);
    params.push(options.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;

  params.push(limit);

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM plans
     ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(...params) as Record<string, unknown>[];

  return rows.map(toPlanRow);
}

/**
 * List all plans associated with a specific session, ordered by created_at DESC.
 */
export function listPlansBySession(sessionId: string): PlanRow[] {
  const db = getDatabase();

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM plans
     WHERE session_id = ?
     ORDER BY created_at DESC`,
  ).all(sessionId) as Record<string, unknown>[];

  return rows.map(toPlanRow);
}
