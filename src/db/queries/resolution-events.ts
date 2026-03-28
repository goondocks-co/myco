/**
 * Resolution event CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { DEFAULT_MACHINE_ID } from '@myco/constants.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';

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
  machine_id?: string;
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
  machine_id: string;
  synced_at: number | null;
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
  'machine_id',
  'synced_at',
] as const;

const SELECT_COLUMNS = EVENT_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed ResolutionEventRow. */
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
    machine_id: (row.machine_id as string) ?? DEFAULT_MACHINE_ID,
    synced_at: (row.synced_at as number) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new resolution event.
 */
export function insertResolutionEvent(
  data: ResolutionEventInsert,
): ResolutionEventRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO resolution_events (
       id, agent_id, spore_id, action, new_spore_id, reason, session_id, created_at, machine_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.agent_id,
    data.spore_id,
    data.action,
    data.new_spore_id ?? null,
    data.reason ?? null,
    data.session_id ?? null,
    data.created_at,
    data.machine_id ?? DEFAULT_MACHINE_ID,
  );

  const row = toResolutionEventRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM resolution_events WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );

  syncRow('resolution_events', row);

  return row;
}

/**
 * List resolution events with optional filters, ordered by created_at DESC.
 */
export function listResolutionEvents(
  options: ListResolutionEventsOptions = {},
): ResolutionEventRow[] {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.agent_id !== undefined) {
    conditions.push(`agent_id = ?`);
    params.push(options.agent_id);
  }

  if (options.spore_id !== undefined) {
    conditions.push(`spore_id = ?`);
    params.push(options.spore_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;

  params.push(limit);

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM resolution_events
     ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(...params) as Record<string, unknown>[];

  return rows.map(toResolutionEventRow);
}
