/**
 * Tests for agent turn CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertTurn, listTurns } from '@myco/db/queries/turns.js';
import type { TurnInsert } from '@myco/db/queries/turns.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Shared agent and run IDs used across tests. */
const TEST_AGENT_ID = 'agent-turns-test';
const TEST_RUN_ID = 'run-turns-test';

/** Factory for minimal valid turn data. */
function makeTurn(overrides: Partial<TurnInsert> = {}): TurnInsert {
  return {
    run_id: TEST_RUN_ID,
    agent_id: TEST_AGENT_ID,
    turn_number: 1,
    tool_name: 'vault_search',
    ...overrides,
  };
}

describe('turn query helpers', () => {
  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);
    // Insert FK targets
    await registerAgent({
      id: TEST_AGENT_ID,
      name: 'Test Agent',
      created_at: epochNow(),
    });
    await insertRun({
      id: TEST_RUN_ID,
      agent_id: TEST_AGENT_ID,
      started_at: epochNow(),
    });
  });

  afterEach(async () => {
    await closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // insertTurn
  // ---------------------------------------------------------------------------

  describe('insertTurn', () => {
    it('inserts a turn and returns it with auto-generated id', async () => {
      const now = epochNow();
      const data = makeTurn({
        tool_input: '{"query":"recent sessions"}',
        tool_output_summary: 'Found 5 sessions',
        started_at: now - 2,
        completed_at: now,
      });
      const row = await insertTurn(data);

      expect(typeof row.id).toBe('number');
      expect(row.run_id).toBe(TEST_RUN_ID);
      expect(row.agent_id).toBe(TEST_AGENT_ID);
      expect(row.turn_number).toBe(1);
      expect(row.tool_name).toBe('vault_search');
      expect(row.tool_input).toBe('{"query":"recent sessions"}');
      expect(row.tool_output_summary).toBe('Found 5 sessions');
      expect(row.started_at).toBe(now - 2);
      expect(row.completed_at).toBe(now);
    });

    it('inserts a turn with minimal fields', async () => {
      const data = makeTurn();
      const row = await insertTurn(data);

      expect(row.tool_input).toBeNull();
      expect(row.tool_output_summary).toBeNull();
      expect(row.started_at).toBeNull();
      expect(row.completed_at).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listTurns
  // ---------------------------------------------------------------------------

  describe('listTurns', () => {
    it('returns turns for a run ordered by turn_number ASC', async () => {
      await insertTurn(makeTurn({ turn_number: 3, tool_name: 'vault_report' }));
      await insertTurn(makeTurn({ turn_number: 1, tool_name: 'vault_search' }));
      await insertTurn(makeTurn({ turn_number: 2, tool_name: 'vault_read' }));

      const rows = await listTurns(TEST_RUN_ID);
      expect(rows).toHaveLength(3);
      expect(rows[0].turn_number).toBe(1);
      expect(rows[0].tool_name).toBe('vault_search');
      expect(rows[1].turn_number).toBe(2);
      expect(rows[1].tool_name).toBe('vault_read');
      expect(rows[2].turn_number).toBe(3);
      expect(rows[2].tool_name).toBe('vault_report');
    });

    it('returns empty array for run with no turns', async () => {
      const rows = await listTurns('no-such-run');
      expect(rows).toEqual([]);
    });
  });
});
