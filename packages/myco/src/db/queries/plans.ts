/**
 * Plan CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { epochSeconds } from '@myco/constants.js';
import { getTeamMachineId, isTeamSyncEnabled } from '@myco/daemon/team-context.js';
import { enqueueOutbox } from '@myco/db/queries/team-outbox.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';

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
  prompt_batch_id?: number | null;
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
  prompt_batch_id: number | null;
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
  project_id?: string | null;
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
    prompt_batch_id: (row.prompt_batch_id as number) ?? null,
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
  const projectId = data.project_id ?? null;
  const existing = getPlanByLogicalKey(data.logical_key, projectId);

  if (existing) {
    db.prepare(
      `UPDATE plans
          SET id              = ?,
              status          = ?,
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
      data.updated_at ?? null,
      data.content_hash ?? null,
      existing.id,
    );

    const row = getPlan(data.id);
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
    projectId,
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
export function getPlan(id: string, projectId?: string | null): PlanRow | null {
  const db = getDatabase();

  const row = projectId === undefined
    ? db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM plans WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined
    : projectId === null
      ? db.prepare(
        `SELECT ${SELECT_COLUMNS} FROM plans WHERE id = ? AND project_id IS NULL`,
      ).get(id) as Record<string, unknown> | undefined
      : db.prepare(
        `SELECT ${SELECT_COLUMNS} FROM plans WHERE id = ? AND project_id = ?`,
      ).get(id, projectId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toPlanRow(row);
}

/**
 * Retrieve a single plan by logical key.
 *
 * @returns the plan row, or null if not found.
 */
export function getPlanByLogicalKey(logicalKey: string, projectId?: string | null): PlanRow | null {
  const db = getDatabase();

  const row = projectId == null
    ? db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM plans
        WHERE project_id IS NULL
          AND logical_key = ?`,
    ).get(logicalKey) as Record<string, unknown> | undefined
    : db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM plans
        WHERE project_id = ?
          AND logical_key = ?`,
    ).get(projectId, logicalKey) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toPlanRow(row);
}

/**
 * Delete a single plan by id and enqueue a team-sync tombstone when enabled.
 *
 * @returns the deleted plan row, or null if not found.
 */
export function deletePlan(id: string, projectId?: string | null): PlanRow | null {
  const db = getDatabase();
  const row = getPlan(id, projectId);
  if (!row) return null;

  const info = projectId === undefined
    ? db.prepare(`DELETE FROM plans WHERE id = ?`).run(id)
    : projectId === null
      ? db.prepare(`DELETE FROM plans WHERE id = ? AND project_id IS NULL`).run(id)
      : db.prepare(`DELETE FROM plans WHERE id = ? AND project_id = ?`).run(id, projectId);
  if (info.changes === 0) return null;

  if (isTeamSyncEnabled()) {
    enqueueOutbox({
      table_name: 'plans',
      row_id: row.id,
      operation: 'delete',
      payload: JSON.stringify({
        id: row.id,
        logical_key: row.logical_key,
        title: row.title,
      }),
      machine_id: getTeamMachineId(),
      created_at: epochSeconds(),
    });
  }

  return row;
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

  if (options.project_id !== undefined) {
    if (options.project_id === null) {
      conditions.push(`project_id IS NULL`);
    } else {
      conditions.push(`project_id = ?`);
      params.push(options.project_id);
    }
  }

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
export function listPlansBySession(sessionId: string, projectId?: string | null): PlanRow[] {
  const db = getDatabase();
  const conditions = ['session_id = ?'];
  const params: unknown[] = [sessionId];

  if (projectId !== undefined) {
    if (projectId === null) {
      conditions.push(`project_id IS NULL`);
    } else {
      conditions.push(`project_id = ?`);
      params.push(projectId);
    }
  }

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM plans
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
  ).all(...params) as Record<string, unknown>[];

  return rows.map(toPlanRow);
}
