/**
 * Agent state key-value query helpers.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Row shape returned from agent_state queries. */
export interface AgentStateRow {
  agent_id: string;
  key: string;
  value: string;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const STATE_COLUMNS = [
  'agent_id',
  'key',
  'value',
  'updated_at',
] as const;

const SELECT_COLUMNS = STATE_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed AgentStateRow. */
function toAgentStateRow(row: Record<string, unknown>): AgentStateRow {
  return {
    agent_id: row.agent_id as string,
    key: row.key as string,
    value: row.value as string,
    updated_at: row.updated_at as number,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a single state value for an agent by key.
 *
 * @returns the state row, or null if not found.
 */
export async function getState(
  agentId: string,
  key: string,
): Promise<AgentStateRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM agent_state WHERE agent_id = $1 AND key = $2`,
    [agentId, key],
  );

  if (result.rows.length === 0) return null;
  return toAgentStateRow(result.rows[0] as Record<string, unknown>);
}

/**
 * Set a state value for an agent. Inserts or updates on conflict.
 *
 * The composite primary key (agent_id, key) ensures each agent
 * has at most one value per key. On conflict, the value and updated_at
 * are overwritten.
 */
export async function setState(
  agentId: string,
  key: string,
  value: string,
  updatedAt: number,
): Promise<AgentStateRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO agent_state (agent_id, key, value, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id, key) DO UPDATE SET
       value      = EXCLUDED.value,
       updated_at = EXCLUDED.updated_at
     RETURNING ${SELECT_COLUMNS}`,
    [agentId, key, value, updatedAt],
  );

  return toAgentStateRow(result.rows[0] as Record<string, unknown>);
}

/**
 * Get all state key-value pairs for an agent, ordered by key ASC.
 */
export async function getStatesForAgent(
  agentId: string,
): Promise<AgentStateRow[]> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_state
     WHERE agent_id = $1
     ORDER BY key ASC`,
    [agentId],
  );

  return (result.rows as Record<string, unknown>[]).map(toAgentStateRow);
}
