/**
 * Agent run CRUD query helpers.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of runs returned by listRuns when no limit given. */
const DEFAULT_LIST_LIMIT = 100;

/** Default run status for new runs. */
const DEFAULT_STATUS = 'pending';

/** Run status indicating the run is currently executing. */
export const STATUS_RUNNING = 'running';

/** Run status for a successfully completed run. */
export const STATUS_COMPLETED = 'completed';

/** Run status for a run that encountered an error. */
export const STATUS_FAILED = 'failed';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting a run. */
export interface RunInsert {
  id: string;
  agent_id: string;
  task?: string | null;
  instruction?: string | null;
  status?: string;
  started_at?: number | null;
  completed_at?: number | null;
  tokens_used?: number | null;
  cost_usd?: number | null;
  actions_taken?: string | null;
  error?: string | null;
}

/** Row shape returned from agent_runs queries (all columns). */
export interface RunRow {
  id: string;
  agent_id: string;
  task: string | null;
  instruction: string | null;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  actions_taken: string | null;
  error: string | null;
}

/** Completion data passed to updateRunStatus. */
export interface RunCompletion {
  completed_at?: number;
  tokens_used?: number;
  cost_usd?: number;
  actions_taken?: string;
  error?: string;
}

/** Filter options for `listRuns`. */
export interface ListRunsOptions {
  limit?: number;
  agent_id?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const RUN_COLUMNS = [
  'id',
  'agent_id',
  'task',
  'instruction',
  'status',
  'started_at',
  'completed_at',
  'tokens_used',
  'cost_usd',
  'actions_taken',
  'error',
] as const;

const SELECT_COLUMNS = RUN_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed RunRow. */
function toRunRow(row: Record<string, unknown>): RunRow {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    task: (row.task as string) ?? null,
    instruction: (row.instruction as string) ?? null,
    status: row.status as string,
    started_at: (row.started_at as number) ?? null,
    completed_at: (row.completed_at as number) ?? null,
    tokens_used: (row.tokens_used as number) ?? null,
    cost_usd: (row.cost_usd as number) ?? null,
    actions_taken: (row.actions_taken as string) ?? null,
    error: (row.error as string) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new agent run.
 */
export async function insertRun(data: RunInsert): Promise<RunRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO agent_runs (
       id, agent_id, task, instruction, status,
       started_at, completed_at, tokens_used, cost_usd,
       actions_taken, error
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11
     )
     RETURNING ${SELECT_COLUMNS}`,
    [
      data.id,
      data.agent_id,
      data.task ?? null,
      data.instruction ?? null,
      data.status ?? DEFAULT_STATUS,
      data.started_at ?? null,
      data.completed_at ?? null,
      data.tokens_used ?? null,
      data.cost_usd ?? null,
      data.actions_taken ?? null,
      data.error ?? null,
    ],
  );

  return toRunRow(result.rows[0] as Record<string, unknown>);
}

/**
 * Retrieve a single run by id.
 *
 * @returns the run row, or null if not found.
 */
export async function getRun(id: string): Promise<RunRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM agent_runs WHERE id = $1`,
    [id],
  );

  if (result.rows.length === 0) return null;
  return toRunRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List runs with optional filters, ordered by started_at DESC (nulls last).
 */
export async function listRuns(
  options: ListRunsOptions = {},
): Promise<RunRow[]> {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.agent_id !== undefined) {
    conditions.push(`agent_id = $${paramIndex++}`);
    params.push(options.agent_id);
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
     FROM agent_runs
     ${where}
     ORDER BY started_at DESC NULLS LAST
     LIMIT $${paramIndex}`,
    params,
  );

  return (result.rows as Record<string, unknown>[]).map(toRunRow);
}

/**
 * Update a run's status, with optional completion data.
 *
 * @returns the updated row, or null if the run does not exist.
 */
export async function updateRunStatus(
  id: string,
  status: string,
  completion?: RunCompletion,
): Promise<RunRow | null> {
  const db = getDatabase();

  const setClauses: string[] = ['status = $1'];
  const params: unknown[] = [status];
  let paramIndex = 2;

  if (completion?.completed_at !== undefined) {
    setClauses.push(`completed_at = $${paramIndex++}`);
    params.push(completion.completed_at);
  }

  if (completion?.tokens_used !== undefined) {
    setClauses.push(`tokens_used = $${paramIndex++}`);
    params.push(completion.tokens_used);
  }

  if (completion?.cost_usd !== undefined) {
    setClauses.push(`cost_usd = $${paramIndex++}`);
    params.push(completion.cost_usd);
  }

  if (completion?.actions_taken !== undefined) {
    setClauses.push(`actions_taken = $${paramIndex++}`);
    params.push(completion.actions_taken);
  }

  if (completion?.error !== undefined) {
    setClauses.push(`error = $${paramIndex++}`);
    params.push(completion.error);
  }

  params.push(id);

  const result = await db.query(
    `UPDATE agent_runs
     SET ${setClauses.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING ${SELECT_COLUMNS}`,
    params,
  );

  if (result.rows.length === 0) return null;
  return toRunRow(result.rows[0] as Record<string, unknown>);
}

/**
 * Get the currently running run for an agent, if any.
 *
 * @returns the running run row, or null if no run is active.
 */
export async function getRunningRun(
  agentId: string,
): Promise<RunRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_runs
     WHERE agent_id = $1 AND status = $2
     ORDER BY started_at DESC NULLS LAST
     LIMIT 1`,
    [agentId, STATUS_RUNNING],
  );

  if (result.rows.length === 0) return null;
  return toRunRow(result.rows[0] as Record<string, unknown>);
}
