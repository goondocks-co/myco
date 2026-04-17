/**
 * Evaluation matrix CRUD query helpers.
 *
 * An "evaluation" is a grouping record for a matrix of runs (same task
 * executed across runtime × reasoning × model × dryRun dimensions). Child
 * runs link back via `agent_runs.evaluation_id`.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 */

import { getDatabase } from '@myco/db/client.js';
import { epochSeconds } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default list page size when no limit given. */
const DEFAULT_LIMIT = 50;

export const EVAL_STATUS_PENDING = 'pending';
export const EVAL_STATUS_RUNNING = 'running';
export const EVAL_STATUS_COMPLETED = 'completed';
export const EVAL_STATUS_FAILED = 'failed';

export type EvaluationStatus =
  | typeof EVAL_STATUS_PENDING
  | typeof EVAL_STATUS_RUNNING
  | typeof EVAL_STATUS_COMPLETED
  | typeof EVAL_STATUS_FAILED;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required when inserting an evaluation. */
export interface EvaluationInsert {
  id: string;
  taskId: string;
  /** Matrix dimensions; stored as JSON. */
  matrix: unknown;
  notes?: string | null;
  /** Override for created_at (defaults to `epochSeconds()`). */
  createdAt?: number;
}

/**
 * Row shape returned from agent_run_evaluations queries. `matrix` is parsed
 * back to a JS value here so callers don't need to double-decode.
 */
export interface EvaluationRow {
  id: string;
  task_id: string;
  matrix: unknown;
  notes: string | null;
  status: EvaluationStatus;
  created_at: number;
  completed_at: number | null;
}

export interface ListEvaluationsOptions {
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const EVAL_COLUMNS = [
  'id',
  'task_id',
  'matrix_json',
  'notes',
  'status',
  'created_at',
  'completed_at',
] as const;

const SELECT_COLUMNS = EVAL_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toEvaluationRow(row: Record<string, unknown>): EvaluationRow {
  const matrixJson = row.matrix_json as string;
  let matrix: unknown = null;
  if (matrixJson) {
    try {
      matrix = JSON.parse(matrixJson);
    } catch {
      matrix = null;
    }
  }
  return {
    id: row.id as string,
    task_id: row.task_id as string,
    matrix,
    notes: (row.notes as string) ?? null,
    status: row.status as EvaluationStatus,
    created_at: row.created_at as number,
    completed_at: (row.completed_at as number) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new evaluation. `matrix` is JSON-stringified on the way in.
 * Returns the hydrated row.
 */
export function insertEvaluation(data: EvaluationInsert): EvaluationRow {
  const db = getDatabase();
  const createdAt = data.createdAt ?? epochSeconds();

  db.prepare(
    `INSERT INTO agent_run_evaluations
       (id, task_id, matrix_json, notes, status, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    data.id,
    data.taskId,
    JSON.stringify(data.matrix ?? null),
    data.notes ?? null,
    EVAL_STATUS_PENDING,
    createdAt,
  );

  return getEvaluation(data.id)!;
}

/** Fetch a single evaluation by id. */
export function getEvaluation(id: string): EvaluationRow | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM agent_run_evaluations WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? toEvaluationRow(row) : null;
}

/** List evaluations, newest first. */
export function listEvaluations(
  options: ListEvaluationsOptions = {},
): EvaluationRow[] {
  const db = getDatabase();
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_run_evaluations
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  ).all(limit, offset) as Record<string, unknown>[];

  return rows.map(toEvaluationRow);
}

/**
 * Update an evaluation's status and (optionally) its completed_at. Pass
 * `completedAt` explicitly so callers can stamp the same value across a
 * batch of rows.
 */
export function updateEvaluationStatus(
  id: string,
  status: EvaluationStatus,
  completedAt?: number | null,
): EvaluationRow | null {
  const db = getDatabase();
  if (completedAt === undefined) {
    db.prepare(
      `UPDATE agent_run_evaluations SET status = ? WHERE id = ?`,
    ).run(status, id);
  } else {
    db.prepare(
      `UPDATE agent_run_evaluations SET status = ?, completed_at = ? WHERE id = ?`,
    ).run(status, completedAt, id);
  }
  return getEvaluation(id);
}

// listRunsForEvaluation lives canonically in `runs.ts` (it's an
// agent_runs query, not an evaluation-table query). Importing from there
// would create a cycle; consumers should import it directly from
// `./runs.js`.
