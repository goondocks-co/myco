/**
 * Agent task CRUD query helpers.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of tasks returned by listTasks when no limit given. */
const DEFAULT_LIST_LIMIT = 100;

/** Default task source for new tasks. */
const DEFAULT_SOURCE = 'built-in';

/** Default is_default flag for new tasks. */
const DEFAULT_IS_DEFAULT = 0;

/** Value indicating a task is the default for its agent. */
const IS_DEFAULT_TRUE = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when upserting a task. */
export interface TaskInsert {
  id: string;
  agent_id: string;
  prompt: string;
  created_at: number;
  source?: string;
  display_name?: string | null;
  description?: string | null;
  is_default?: number;
  tool_overrides?: string | null;
  model?: string | null;
  config?: string | null;
  updated_at?: number | null;
}

/** Row shape returned from agent_tasks queries (all columns). */
export interface TaskRow {
  id: string;
  agent_id: string;
  source: string;
  display_name: string | null;
  description: string | null;
  prompt: string;
  is_default: number;
  tool_overrides: string | null;
  model: string | null;
  config: string | null;
  created_at: number;
  updated_at: number | null;
}

/** Filter options for `listTasks`. */
export interface ListTasksOptions {
  limit?: number;
  agent_id?: string;
  source?: string;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const TASK_COLUMNS = [
  'id',
  'agent_id',
  'source',
  'display_name',
  'description',
  'prompt',
  'is_default',
  'tool_overrides',
  'model',
  'config',
  'created_at',
  'updated_at',
] as const;

const SELECT_COLUMNS = TASK_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed TaskRow. */
function toTaskRow(row: Record<string, unknown>): TaskRow {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    source: (row.source as string) ?? DEFAULT_SOURCE,
    display_name: (row.display_name as string) ?? null,
    description: (row.description as string) ?? null,
    prompt: row.prompt as string,
    is_default: (row.is_default as number) ?? DEFAULT_IS_DEFAULT,
    tool_overrides: (row.tool_overrides as string) ?? null,
    model: (row.model as string) ?? null,
    config: (row.config as string) ?? null,
    created_at: row.created_at as number,
    updated_at: (row.updated_at as number) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upsert a task — insert or update on conflict.
 *
 * On conflict the row is updated with the values from `data`.
 * This is the idempotent upsert — calling twice with the same data
 * produces the same result.
 */
export async function upsertTask(data: TaskInsert): Promise<TaskRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO agent_tasks (
       id, agent_id, source, display_name, description,
       prompt, is_default, tool_overrides, model, config,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12
     )
     ON CONFLICT (id) DO UPDATE SET
       agent_id       = EXCLUDED.agent_id,
       source         = EXCLUDED.source,
       display_name   = EXCLUDED.display_name,
       description    = EXCLUDED.description,
       prompt         = EXCLUDED.prompt,
       is_default     = EXCLUDED.is_default,
       tool_overrides = EXCLUDED.tool_overrides,
       model          = EXCLUDED.model,
       config         = EXCLUDED.config,
       updated_at     = EXCLUDED.updated_at
     RETURNING ${SELECT_COLUMNS}`,
    [
      data.id,
      data.agent_id,
      data.source ?? DEFAULT_SOURCE,
      data.display_name ?? null,
      data.description ?? null,
      data.prompt,
      data.is_default ?? DEFAULT_IS_DEFAULT,
      data.tool_overrides ?? null,
      data.model ?? null,
      data.config ?? null,
      data.created_at,
      data.updated_at ?? null,
    ],
  );

  return toTaskRow(result.rows[0] as Record<string, unknown>);
}

/**
 * Retrieve a single task by id.
 *
 * @returns the task row, or null if not found.
 */
export async function getTask(id: string): Promise<TaskRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM agent_tasks WHERE id = $1`,
    [id],
  );

  if (result.rows.length === 0) return null;
  return toTaskRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List tasks with optional filters, ordered by created_at ASC.
 */
export async function listTasks(
  options: ListTasksOptions = {},
): Promise<TaskRow[]> {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.agent_id !== undefined) {
    conditions.push(`agent_id = $${paramIndex++}`);
    params.push(options.agent_id);
  }

  if (options.source !== undefined) {
    conditions.push(`source = $${paramIndex++}`);
    params.push(options.source);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;

  params.push(limit);

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_tasks
     ${where}
     ORDER BY created_at ASC
     LIMIT $${paramIndex}`,
    params,
  );

  return (result.rows as Record<string, unknown>[]).map(toTaskRow);
}

/**
 * Get the default task for an agent.
 *
 * @returns the default task row, or null if no default exists.
 */
export async function getDefaultTask(
  agentId: string,
): Promise<TaskRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_tasks
     WHERE agent_id = $1 AND is_default = $2
     LIMIT 1`,
    [agentId, IS_DEFAULT_TRUE],
  );

  if (result.rows.length === 0) return null;
  return toTaskRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List all tasks for an agent, ordered by display_name ASC.
 *
 * Rows with a null display_name sort before named tasks.
 */
export async function listTasksByAgent(
  agentId: string,
): Promise<TaskRow[]> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_tasks
     WHERE agent_id = $1
     ORDER BY display_name ASC`,
    [agentId],
  );

  return (result.rows as Record<string, unknown>[]).map(toTaskRow);
}
