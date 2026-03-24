/**
 * Tests for agent run CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import {
  insertRun,
  getRun,
  listRuns,
  updateRunStatus,
  getRunningRun,
} from '@myco/db/queries/runs.js';
import type { RunInsert } from '@myco/db/queries/runs.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Shared agent ID used across tests. */
const TEST_AGENT_ID = 'agent-runs-test';

/** Factory for minimal valid run data. */
function makeRun(overrides: Partial<RunInsert> = {}): RunInsert {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    agent_id: TEST_AGENT_ID,
    ...overrides,
  };
}

describe('run query helpers', () => {
  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);
    // Insert the agent FK target
    await registerAgent({
      id: TEST_AGENT_ID,
      name: 'Test Agent',
      created_at: epochNow(),
    });
  });

  afterEach(async () => {
    await closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // insertRun + getRun
  // ---------------------------------------------------------------------------

  describe('insertRun', () => {
    it('inserts a new run and retrieves it', async () => {
      const now = epochNow();
      const data = makeRun({ task: 'digest', instruction: 'analyze recent sessions', started_at: now });
      const row = await insertRun(data);

      expect(row.id).toBe(data.id);
      expect(row.agent_id).toBe(TEST_AGENT_ID);
      expect(row.task).toBe('digest');
      expect(row.instruction).toBe('analyze recent sessions');
      expect(row.status).toBe('pending');
      expect(row.started_at).toBe(now);
      expect(row.completed_at).toBeNull();
      expect(row.tokens_used).toBeNull();
      expect(row.cost_usd).toBeNull();
      expect(row.actions_taken).toBeNull();
      expect(row.error).toBeNull();

      const fetched = await getRun(data.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
      expect(fetched!.instruction).toBe('analyze recent sessions');
    });

    it('inserts with all optional fields', async () => {
      const now = epochNow();
      const data = makeRun({
        task: 'curate',
        instruction: 'curate spores',
        status: 'completed',
        started_at: now - 60,
        completed_at: now,
        tokens_used: 5000,
        cost_usd: 0.05,
        actions_taken: '["report"]',
        error: null,
      });
      const row = await insertRun(data);

      expect(row.status).toBe('completed');
      expect(row.completed_at).toBe(now);
      expect(row.tokens_used).toBe(5000);
      expect(row.cost_usd).toBe(0.05);
      expect(row.actions_taken).toBe('["report"]');
    });
  });

  // ---------------------------------------------------------------------------
  // getRun
  // ---------------------------------------------------------------------------

  describe('getRun', () => {
    it('returns null for non-existent id', async () => {
      const row = await getRun('does-not-exist');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listRuns
  // ---------------------------------------------------------------------------

  describe('listRuns', () => {
    it('returns runs ordered by started_at DESC', async () => {
      const now = epochNow();
      await insertRun(makeRun({ id: 'run-old', started_at: now - 200 }));
      await insertRun(makeRun({ id: 'run-mid', started_at: now - 100 }));
      await insertRun(makeRun({ id: 'run-new', started_at: now }));

      const rows = await listRuns();
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('run-new');
      expect(rows[1].id).toBe('run-mid');
      expect(rows[2].id).toBe('run-old');
    });

    it('filters by agent_id', async () => {
      // Create a second agent
      await registerAgent({
        id: 'agent-other',
        name: 'Other Agent',
        created_at: epochNow(),
      });

      await insertRun(makeRun({ id: 'run-a', started_at: epochNow() }));
      await insertRun(makeRun({ id: 'run-b', agent_id: 'agent-other', started_at: epochNow() }));

      const rows = await listRuns({ agent_id: TEST_AGENT_ID });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('run-a');
    });

    it('filters by status', async () => {
      await insertRun(makeRun({ id: 'run-pending', status: 'pending', started_at: epochNow() }));
      await insertRun(makeRun({ id: 'run-running', status: 'running', started_at: epochNow() }));

      const rows = await listRuns({ status: 'running' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('run-running');
    });

    it('respects limit', async () => {
      const now = epochNow();
      await insertRun(makeRun({ id: 'run-1', started_at: now - 2 }));
      await insertRun(makeRun({ id: 'run-2', started_at: now - 1 }));
      await insertRun(makeRun({ id: 'run-3', started_at: now }));

      const rows = await listRuns({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('returns empty array when no runs exist', async () => {
      const rows = await listRuns();
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // updateRunStatus
  // ---------------------------------------------------------------------------

  describe('updateRunStatus', () => {
    it('updates status only', async () => {
      const data = makeRun({ started_at: epochNow() });
      await insertRun(data);

      const updated = await updateRunStatus(data.id, 'running');
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('running');
    });

    it('updates status with completion data', async () => {
      const now = epochNow();
      const data = makeRun({ started_at: now - 10 });
      await insertRun(data);

      const updated = await updateRunStatus(data.id, 'completed', {
        completed_at: now,
        tokens_used: 1200,
        cost_usd: 0.02,
        actions_taken: '["write_spore","report"]',
      });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.completed_at).toBe(now);
      expect(updated!.tokens_used).toBe(1200);
      expect(updated!.cost_usd).toBe(0.02);
      expect(updated!.actions_taken).toBe('["write_spore","report"]');
    });

    it('updates status with error', async () => {
      const data = makeRun({ started_at: epochNow() });
      await insertRun(data);

      const updated = await updateRunStatus(data.id, 'failed', {
        error: 'LLM timeout',
        completed_at: epochNow(),
      });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('failed');
      expect(updated!.error).toBe('LLM timeout');
    });

    it('returns null for non-existent id', async () => {
      const updated = await updateRunStatus('does-not-exist', 'running');
      expect(updated).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getRunningRun
  // ---------------------------------------------------------------------------

  describe('getRunningRun', () => {
    it('returns the running run for an agent', async () => {
      const data = makeRun({ status: 'running', started_at: epochNow() });
      await insertRun(data);

      const running = await getRunningRun(TEST_AGENT_ID);
      expect(running).not.toBeNull();
      expect(running!.id).toBe(data.id);
      expect(running!.status).toBe('running');
    });

    it('returns null when no run is running', async () => {
      await insertRun(makeRun({ status: 'completed', started_at: epochNow() }));

      const running = await getRunningRun(TEST_AGENT_ID);
      expect(running).toBeNull();
    });

    it('returns the most recent running run', async () => {
      const now = epochNow();
      await insertRun(makeRun({ id: 'run-old', status: 'running', started_at: now - 100 }));
      await insertRun(makeRun({ id: 'run-new', status: 'running', started_at: now }));

      const running = await getRunningRun(TEST_AGENT_ID);
      expect(running).not.toBeNull();
      expect(running!.id).toBe('run-new');
    });
  });
});
