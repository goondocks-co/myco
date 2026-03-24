/**
 * Vault context builder for agent task prompt injection.
 *
 * Queries PGlite for aggregate vault metrics and agent state,
 * then formats them as a markdown block suitable for inclusion
 * in the agent's task prompt.
 */

import { getDatabase } from '@myco/db/client.js';
import { getStatesForAgent } from '@myco/db/queries/agent-state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default value for unset state entries. */
const STATE_UNSET = '(unset)';

/** Key used by the agent to store its last processed batch ID. */
const STATE_KEY_LAST_PROCESSED_BATCH = 'last_processed_batch_id';

/** Status value for active spores. */
const SPORE_STATUS_ACTIVE = 'active';

// ---------------------------------------------------------------------------
// Count helpers
// ---------------------------------------------------------------------------

/**
 * Count rows in a table with optional WHERE clause.
 *
 * The table name is validated by the caller (always a literal from this module).
 * Parameterized `conditions` protect against SQL injection for dynamic values.
 */
async function countRows(
  table: string,
  conditions: Array<{ clause: string; value: unknown }> = [],
): Promise<number> {
  const db = getDatabase();

  const whereParts: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  for (const { clause, value } of conditions) {
    whereParts.push(clause.replace('?', `$${paramIndex++}`));
    params.push(value);
  }

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const result = await db.query<{ count: string }>(
    `SELECT count(*) AS count FROM ${table} ${whereClause}`,
    params,
  );

  return Number(result.rows[0].count);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a markdown context block describing the current vault state
 * for a specific agent.
 *
 * Includes:
 * - Agent state key-value pairs (cursor position, preferences)
 * - Aggregate counts (sessions, spores, entities, edges, unprocessed batches)
 * - Last digest timestamp (if any)
 *
 * @param agentId — the agent to build context for.
 * @returns a markdown-formatted string.
 */
export async function buildVaultContext(agentId: string): Promise<string> {
  // Fetch all state entries and aggregate counts in parallel
  const [
    states,
    totalSessions,
    totalActiveSpores,
    totalEntities,
    totalEdges,
    unprocessedBatches,
    lastDigestAt,
  ] = await Promise.all([
    getStatesForAgent(agentId),
    countRows('sessions'),
    countRows('spores', [{ clause: 'status = ?', value: SPORE_STATUS_ACTIVE }]),
    countRows('entities'),
    countRows('edges'),
    countRows('prompt_batches', [{ clause: 'processed = ?', value: 0 }]),
    getLastDigestTimestamp(agentId),
  ]);
  const stateMap = new Map(states.map((s) => [s.key, s.value]));

  const lastProcessedBatchId = stateMap.get(STATE_KEY_LAST_PROCESSED_BATCH) ?? STATE_UNSET;

  const lines = [
    '## Current Vault State',
    `agent_id: ${agentId}`,
    `last_processed_batch_id: ${lastProcessedBatchId}`,
    `unprocessed_batches: ${unprocessedBatches}`,
    `total_sessions: ${totalSessions}`,
    `total_active_spores: ${totalActiveSpores}`,
    `total_entities: ${totalEntities}`,
    `total_edges: ${totalEdges}`,
    `last_digest_at: ${lastDigestAt}`,
  ];

  return lines.join('\n');
}

/**
 * Get the most recent digest generation timestamp for an agent.
 *
 * @returns epoch seconds of the last digest, or 0 if no digests exist.
 */
async function getLastDigestTimestamp(agentId: string): Promise<number> {
  const db = getDatabase();

  const result = await db.query<{ max_at: number | null }>(
    `SELECT MAX(generated_at) AS max_at
     FROM digest_extracts
     WHERE agent_id = $1`,
    [agentId],
  );

  return result.rows[0]?.max_at ?? 0;
}
