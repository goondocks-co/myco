/**
 * Plan CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { getTeamMachineId } from '@myco/team/context.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';
import { appendProjectCondition, type ProjectScope } from '@myco/db/queries/project-scope.js';

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
  logical_key: string;
  created_at: number;
  project_id?: string | null;
  status?: string;
  author?: string | null;
  title?: string | null;
  content?: string | null;
  source_path?: string | null;
  tags?: string | null;
  session_id?: string | null;
  prompt_batch_id?: string | null;
  content_hash?: string | null;
  processed?: number;
  updated_at?: number | null;
  machine_id?: string;
}

/** Row shape returned from plan queries. */
export interface PlanRow {
  id: string;
  project_id: string | null;
  logical_key: string;
  status: string;
  author: string | null;
  title: string | null;
  content: string | null;
  source_path: string | null;
  tags: string | null;
  session_id: string | null;
  prompt_batch_id: string | null;
  content_hash: string | null;
  processed: number;
  embedded: number;
  created_at: number;
  updated_at: number | null;
  machine_id: string;
  synced_at: number | null;
}

/** Filter options for `listPlans`. */
export interface ListPlansOptions {
  scope: ProjectScope;
  status?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const PLAN_COLUMNS = [
  'id',
  'project_id',
  'logical_key',
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
  'machine_id',
  'synced_at',
] as const;

const SELECT_COLUMNS = PLAN_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed PlanRow. */
function toPlanRow(row: Record<string, unknown>): PlanRow {
  return {
    id: row.id as string,
    project_id: (row.project_id as string) ?? null,
    logical_key: row.logical_key as string,
    status: row.status as string,
    author: (row.author as string) ?? null,
    title: (row.title as string) ?? null,
    content: (row.content as string) ?? null,
    source_path: (row.source_path as string) ?? null,
    tags: (row.tags as string) ?? null,
    session_id: (row.session_id as string) ?? null,
    prompt_batch_id: (row.prompt_batch_id as string) ?? null,
    content_hash: (row.content_hash as string) ?? null,
    processed: row.processed as number,
    embedded: (row.embedded as number) ?? 0,
    created_at: row.created_at as number,
    updated_at: (row.updated_at as number) ?? null,
    machine_id: (row.machine_id as string) ?? 'local',
    synced_at: (row.synced_at as number) ?? null,
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
  const scope: ProjectScope = data.project_id == null
    ? { kind: 'global' }
    : { kind: 'project', id: data.project_id as import('@myco/grove/ids.js').GroveProjectId };
  const existing = getPlanByLogicalKey(data.logical_key, scope);

  if (existing) {
    // A found row is matched by logical_key; its id is a stable, opaque handle
    // (lineage edges, team-sync D1 rows reference it) and is NOT re-homed to the
    // incoming data.id. This keeps id stable across re-writes even when the
    // caller recomputes an id from a key the row was re-keyed onto by migration.
    db.prepare(
      `UPDATE plans
          SET status          = ?,
              author          = ?,
              title           = ?,
              content         = ?,
              source_path     = ?,
              tags            = ?,
              session_id      = ?,
              prompt_batch_id = ?,
              content_hash    = ?,
              processed       = ?,
              updated_at      = ?,
              embedded        = CASE
                WHEN ? != content_hash THEN 0
                ELSE embedded
              END
        WHERE id = ?`,
    ).run(
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
      data.updated_at ?? null,
      data.content_hash ?? null,
      existing.id,
    );

    const row = getPlan(existing.id, scope);
    if (!row) throw new Error(`Plan upsert failed for logical key: ${data.logical_key}`);
    syncRow('plans', row);
    return row;
  }

  db.prepare(
    `INSERT INTO plans (
       id, project_id, logical_key, status, author, title, content,
       source_path, tags, session_id, prompt_batch_id, content_hash,
       processed, created_at, updated_at, machine_id
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?
     )`,
  ).run(
    data.id,
    data.project_id ?? null,
    data.logical_key,
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
    data.machine_id ?? getTeamMachineId(),
  );

  const row = toPlanRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM plans WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );

  syncRow('plans', row);

  return row;
}

/**
 * Retrieve a single plan by id.
 *
 * @returns the plan row, or null if not found.
 */
export function getPlan(id: string, scope: ProjectScope): PlanRow | null {
  const db = getDatabase();
  const conditions = ['id = ?'];
  const params: unknown[] = [id];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM plans WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as Record<string, unknown> | undefined;
  if (!row) return null;
  return toPlanRow(row);
}

/**
 * Retrieve a single plan by logical key.
 *
 * @returns the plan row, or null if not found.
 */
export function getPlanByLogicalKey(logicalKey: string, scope: ProjectScope): PlanRow | null {
  const db = getDatabase();
  const conditions = ['logical_key = ?'];
  const params: unknown[] = [logicalKey];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM plans WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as Record<string, unknown> | undefined;
  if (!row) return null;
  return toPlanRow(row);
}

/**
 * Delete a single plan by id and enqueue a team-sync tombstone when enabled.
 *
 * @returns the deleted plan row, or null if not found.
 */
export function deletePlan(id: string, scope: ProjectScope): PlanRow | null {
  const db = getDatabase();
  const row = getPlan(id, scope);
  if (!row) return null;

  const conditions = ['id = ?'];
  const params: unknown[] = [id];
  appendProjectCondition(conditions, params, scope);
  const info = db.prepare(
    `DELETE FROM plans WHERE ${conditions.join(' AND ')}`,
  ).run(...params);
  if (info.changes === 0) return null;

  return row;
}

/**
 * List plans with optional filters, ordered by created_at DESC.
 */
export function listPlans(
  options: ListPlansOptions,
): PlanRow[] {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];

  appendProjectCondition(conditions, params, options.scope);

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
export function listPlansBySession(sessionId: string, scope: ProjectScope): PlanRow[] {
  const db = getDatabase();
  const conditions = ['session_id = ?'];
  const params: unknown[] = [sessionId];
  appendProjectCondition(conditions, params, scope);

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM plans
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
  ).all(...params) as Record<string, unknown>[];

  return rows.map(toPlanRow);
}
