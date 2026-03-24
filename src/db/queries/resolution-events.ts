/**
 * Resolution event CRUD query helpers.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of events returned by listResolutionEvents when no limit given. */
const DEFAULT_LIST_LIMIT = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting a resolution event. */
export interface ResolutionEventInsert {
  id: string;
  agent_id: string;
  spore_id: string;
  action: string;
  created_at: number;
  new_spore_id?: string | null;
  reason?: string | null;
  session_id?: string | null;
}

/** Row shape returned from resolution_events queries (all columns). */
export interface ResolutionEventRow {
  id: string;
  agent_id: string;
  spore_id: string;
  action: string;
  new_spore_id: string | null;
  reason: string | null;
  session_id: string | null;
  created_at: number;
}

/** Filter options for `listResolutionEvents`. */
export interface ListResolutionEventsOptions {
  agent_id?: string;
  spore_id?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const EVENT_COLUMNS = [
  'id',
  'agent_id',
  'spore_id',
  'action',
  'new_spore_id',
  'reason',
  'session_id',
  'created_at',
] as const;

const SELECT_COLUMNS = EVENT_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed ResolutionEventRow. */
function toResolutionEventRow(row: Record<string, unknown>): ResolutionEventRow {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    spore_id: row.spore_id as string,
    action: row.action as string,
    new_spore_id: (row.new_spore_id as string) ?? null,
    reason: (row.reason as string) ?? null,
    session_id: (row.session_id as string) ?? null,
    created_at: row.created_at as number,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new resolution event.
 */
export async function insertResolutionEvent(
  data: ResolutionEventInsert,
): Promise<ResolutionEventRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO resolution_events (
       id, agent_id, spore_id, action, new_spore_id, reason, session_id, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${SELECT_COLUMNS}`,
    [
      data.id,
      data.agent_id,
      data.spore_id,
      data.action,
      data.new_spore_id ?? null,
      data.reason ?? null,
      data.session_id ?? null,
      data.created_at,
    ],
  );

  return toResolutionEventRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List resolution events with optional filters, ordered by created_at DESC.
 */
export async function listResolutionEvents(
  options: ListResolutionEventsOptions = {},
): Promise<ResolutionEventRow[]> {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.agent_id !== undefined) {
    conditions.push(`agent_id = $${paramIndex++}`);
    params.push(options.agent_id);
  }

  if (options.spore_id !== undefined) {
    conditions.push(`spore_id = $${paramIndex++}`);
    params.push(options.spore_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;

  params.push(limit);

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM resolution_events
     ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIndex}`,
    params,
  );

  return (result.rows as Record<string, unknown>[]).map(toResolutionEventRow);
}
