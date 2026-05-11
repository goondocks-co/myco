/**
 * Agent state key-value query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Row shape returned from agent_state queries. */
export interface AgentStateRow {
  agent_id: string;
  project_id: string;
  key: string;
  value: string;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const STATE_COLUMNS = [
  'agent_id',
  'project_id',
  'key',
  'value',
  'updated_at',
] as const;

const SELECT_COLUMNS = STATE_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed AgentStateRow. */
function toAgentStateRow(row: Record<string, unknown>): AgentStateRow {
  return {
    agent_id: row.agent_id as string,
    project_id: row.project_id as string,
    key: row.key as string,
    value: row.value as string,
    updated_at: row.updated_at as number,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a single state value for an agent within a project, by key.
 *
 * @returns the state row, or null if not found.
 */
export function getState(
  agentId: string,
  projectId: string,
  key: string,
): AgentStateRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM agent_state WHERE agent_id = ? AND project_id = ? AND key = ?`,
  ).get(agentId, projectId, key) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toAgentStateRow(row);
}

/**
 * Set a state value for an agent within a project. Inserts or updates on conflict.
 *
 * The composite primary key (agent_id, project_id, key) ensures each agent
 * has at most one value per (project, key). On conflict, the value and
 * updated_at are overwritten.
 */
export function setState(
  agentId: string,
  projectId: string,
  key: string,
  value: string,
  updatedAt: number,
): AgentStateRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO agent_state (agent_id, project_id, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (agent_id, project_id, key) DO UPDATE SET
       value      = EXCLUDED.value,
       updated_at = EXCLUDED.updated_at`,
  ).run(agentId, projectId, key, value, updatedAt);

  return toAgentStateRow(
    db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM agent_state WHERE agent_id = ? AND project_id = ? AND key = ?`,
    ).get(agentId, projectId, key) as Record<string, unknown>,
  );
}

/**
 * Get all state key-value pairs for an agent within a project, ordered by key ASC.
 */
export function getStatesForAgent(
  agentId: string,
  projectId: string,
): AgentStateRow[] {
  const db = getDatabase();

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_state
     WHERE agent_id = ? AND project_id = ?
     ORDER BY key ASC`,
  ).all(agentId, projectId) as Record<string, unknown>[];

  return rows.map(toAgentStateRow);
}
