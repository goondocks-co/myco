/**
 * Agent run CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
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

/** Normalize a SQLite result row into a typed RunRow. */
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
export function insertRun(data: RunInsert): RunRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO agent_runs (
       id, agent_id, task, instruction, status,
       started_at, completed_at, tokens_used, cost_usd,
       actions_taken, error
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?
     )`,
  ).run(
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
  );

  return toRunRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_runs WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );
}

/**
 * Retrieve a single run by id.
 *
 * @returns the run row, or null if not found.
 */
export function getRun(id: string): RunRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM agent_runs WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toRunRow(row);
}

/**
 * List runs with optional filters, ordered by started_at DESC (nulls last).
 */
export function listRuns(
  options: ListRunsOptions = {},
): RunRow[] {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.agent_id !== undefined) {
    conditions.push(`agent_id = ?`);
    params.push(options.agent_id);
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
     FROM agent_runs
     ${where}
     ORDER BY started_at DESC NULLS LAST
     LIMIT ?`,
  ).all(...params) as Record<string, unknown>[];

  return rows.map(toRunRow);
}

/**
 * Update a run's status, with optional completion data.
 *
 * @returns the updated row, or null if the run does not exist.
 */
export function updateRunStatus(
  id: string,
  status: string,
  completion?: RunCompletion,
): RunRow | null {
  const db = getDatabase();

  const setClauses: string[] = ['status = ?'];
  const params: unknown[] = [status];

  if (completion?.completed_at !== undefined) {
    setClauses.push(`completed_at = ?`);
    params.push(completion.completed_at);
  }

  if (completion?.tokens_used !== undefined) {
    setClauses.push(`tokens_used = ?`);
    params.push(completion.tokens_used);
  }

  if (completion?.cost_usd !== undefined) {
    setClauses.push(`cost_usd = ?`);
    params.push(completion.cost_usd);
  }

  if (completion?.actions_taken !== undefined) {
    setClauses.push(`actions_taken = ?`);
    params.push(completion.actions_taken);
  }

  if (completion?.error !== undefined) {
    setClauses.push(`error = ?`);
    params.push(completion.error);
  }

  params.push(id);

  const info = db.prepare(
    `UPDATE agent_runs
     SET ${setClauses.join(', ')}
     WHERE id = ?`,
  ).run(...params);

  if (info.changes === 0) return null;

  return toRunRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_runs WHERE id = ?`).get(id) as Record<string, unknown>,
  );
}

/**
 * Get the currently running run for an agent, if any.
 *
 * @returns the running run row, or null if no run is active.
 */
export function getRunningRun(
  agentId: string,
): RunRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_runs
     WHERE agent_id = ? AND status = ?
     ORDER BY started_at DESC NULLS LAST
     LIMIT 1`,
  ).get(agentId, STATUS_RUNNING) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toRunRow(row);
}
