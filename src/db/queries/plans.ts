/**
 * Plan CRUD query helpers.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
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
  processed: number;
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
  'processed',
  'created_at',
  'updated_at',
] as const;

const SELECT_COLUMNS = PLAN_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed PlanRow. */
function toPlanRow(row: Record<string, unknown>): PlanRow {
  return {
    id: row.id as string,
    status: row.status as string,
    author: (row.author as string) ?? null,
    title: (row.title as string) ?? null,
    content: (row.content as string) ?? null,
    source_path: (row.source_path as string) ?? null,
    tags: (row.tags as string) ?? null,
    processed: row.processed as number,
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
export async function upsertPlan(data: PlanInsert): Promise<PlanRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO plans (
       id, status, author, title, content,
       source_path, tags, processed, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10
     )
     ON CONFLICT (id) DO UPDATE SET
       status      = EXCLUDED.status,
       author      = EXCLUDED.author,
       title       = EXCLUDED.title,
       content     = EXCLUDED.content,
       source_path = EXCLUDED.source_path,
       tags        = EXCLUDED.tags,
       processed   = EXCLUDED.processed,
       updated_at  = EXCLUDED.updated_at
     RETURNING ${SELECT_COLUMNS}`,
    [
      data.id,
      data.status ?? DEFAULT_STATUS,
      data.author ?? null,
      data.title ?? null,
      data.content ?? null,
      data.source_path ?? null,
      data.tags ?? null,
      data.processed ?? DEFAULT_PROCESSED,
      data.created_at,
      data.updated_at ?? null,
    ],
  );

  return toPlanRow(result.rows[0] as Record<string, unknown>);
}

/**
 * Retrieve a single plan by id.
 *
 * @returns the plan row, or null if not found.
 */
export async function getPlan(id: string): Promise<PlanRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM plans WHERE id = $1`,
    [id],
  );

  if (result.rows.length === 0) return null;
  return toPlanRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List plans with optional filters, ordered by created_at DESC.
 */
export async function listPlans(
  options: ListPlansOptions = {},
): Promise<PlanRow[]> {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.status !== undefined) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(options.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;

  params.push(limit);

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM plans
     ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIndex}`,
    params,
  );

  return (result.rows as Record<string, unknown>[]).map(toPlanRow);
}
