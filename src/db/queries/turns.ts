/**
 * Agent turn CRUD query helpers.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting a turn. */
export interface TurnInsert {
  run_id: string;
  curator_id: string;
  turn_number: number;
  tool_name: string;
  tool_input?: string | null;
  tool_output_summary?: string | null;
  started_at?: number | null;
  completed_at?: number | null;
}

/** Row shape returned from agent_turns queries (all columns). */
export interface TurnRow {
  id: number;
  run_id: string;
  curator_id: string;
  turn_number: number;
  tool_name: string;
  tool_input: string | null;
  tool_output_summary: string | null;
  started_at: number | null;
  completed_at: number | null;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const TURN_COLUMNS = [
  'id',
  'run_id',
  'curator_id',
  'turn_number',
  'tool_name',
  'tool_input',
  'tool_output_summary',
  'started_at',
  'completed_at',
] as const;

const SELECT_COLUMNS = TURN_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed TurnRow. */
function toTurnRow(row: Record<string, unknown>): TurnRow {
  return {
    id: row.id as number,
    run_id: row.run_id as string,
    curator_id: row.curator_id as string,
    turn_number: row.turn_number as number,
    tool_name: row.tool_name as string,
    tool_input: (row.tool_input as string) ?? null,
    tool_output_summary: (row.tool_output_summary as string) ?? null,
    started_at: (row.started_at as number) ?? null,
    completed_at: (row.completed_at as number) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new agent turn.
 */
export async function insertTurn(data: TurnInsert): Promise<TurnRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO agent_turns (
       run_id, curator_id, turn_number, tool_name,
       tool_input, tool_output_summary, started_at, completed_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8
     )
     RETURNING ${SELECT_COLUMNS}`,
    [
      data.run_id,
      data.curator_id,
      data.turn_number,
      data.tool_name,
      data.tool_input ?? null,
      data.tool_output_summary ?? null,
      data.started_at ?? null,
      data.completed_at ?? null,
    ],
  );

  return toTurnRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List all turns for a specific run, ordered by turn_number ASC.
 */
export async function listTurns(runId: string): Promise<TurnRow[]> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_turns
     WHERE run_id = $1
     ORDER BY turn_number ASC`,
    [runId],
  );

  return (result.rows as Record<string, unknown>[]).map(toTurnRow);
}

/**
 * List all agent turns for a run, ordered by turn_number ASC.
 *
 * Alias for `listTurns` with an explicit "by run" naming convention used
 * by the dashboard API layer.
 */
export async function listTurnsByRun(runId: string): Promise<TurnRow[]> {
  return listTurns(runId);
}
