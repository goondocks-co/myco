/**
 * Tests for agent run CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import {
  insertRun,
  getRun,
  listRuns,
  countRuns,
  updateRun,
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
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(async () => {
    cleanTestDb();
    // Insert the agent FK target
    registerAgent({
      id: TEST_AGENT_ID,
      name: 'Test Agent',
      created_at: epochNow(),
    });
  });

  // ---------------------------------------------------------------------------
  // insertRun + getRun
  // ---------------------------------------------------------------------------

  describe('insertRun', () => {
    it('inserts a new run and retrieves it', async () => {
      const now = epochNow();
      const data = makeRun({ task: 'digest', instruction: 'analyze recent sessions', started_at: now });
      const row = insertRun(data);

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

      const fetched = getRun(data.id);
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
      const row = insertRun(data);

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
      const row = getRun('does-not-exist');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listRuns
  // ---------------------------------------------------------------------------

  describe('listRuns', () => {
    it('returns runs ordered by started_at DESC', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-old', started_at: now - 200 }));
      insertRun(makeRun({ id: 'run-mid', started_at: now - 100 }));
      insertRun(makeRun({ id: 'run-new', started_at: now }));

      const rows = listRuns();
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('run-new');
      expect(rows[1].id).toBe('run-mid');
      expect(rows[2].id).toBe('run-old');
    });

    it('filters by agent_id', async () => {
      // Create a second agent
      registerAgent({
        id: 'agent-other',
        name: 'Other Agent',
        created_at: epochNow(),
      });

      insertRun(makeRun({ id: 'run-a', started_at: epochNow() }));
      insertRun(makeRun({ id: 'run-b', agent_id: 'agent-other', started_at: epochNow() }));

      const rows = listRuns({ agent_id: TEST_AGENT_ID });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('run-a');
    });

    it('filters by status', async () => {
      insertRun(makeRun({ id: 'run-pending', status: 'pending', started_at: epochNow() }));
      insertRun(makeRun({ id: 'run-running', status: 'running', started_at: epochNow() }));

      const rows = listRuns({ status: 'running' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('run-running');
    });

    it('respects limit', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-1', started_at: now - 2 }));
      insertRun(makeRun({ id: 'run-2', started_at: now - 1 }));
      insertRun(makeRun({ id: 'run-3', started_at: now }));

      const rows = listRuns({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('returns empty array when no runs exist', async () => {
      const rows = listRuns();
      expect(rows).toEqual([]);
    });

    it('paginates with offset', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-1', started_at: now - 2 }));
      insertRun(makeRun({ id: 'run-2', started_at: now - 1 }));
      insertRun(makeRun({ id: 'run-3', started_at: now }));

      // Page 1: first 2 rows
      const page1 = listRuns({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);
      expect(page1[0].id).toBe('run-3');
      expect(page1[1].id).toBe('run-2');

      // Page 2: remaining row
      const page2 = listRuns({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(1);
      expect(page2[0].id).toBe('run-1');
    });

    it('combines offset with status filter', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-done-1', status: 'completed', started_at: now - 3 }));
      insertRun(makeRun({ id: 'run-done-2', status: 'completed', started_at: now - 2 }));
      insertRun(makeRun({ id: 'run-done-3', status: 'completed', started_at: now - 1 }));
      insertRun(makeRun({ id: 'run-pending', status: 'pending', started_at: now }));

      const rows = listRuns({ status: 'completed', limit: 2, offset: 1 });
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('run-done-2');
      expect(rows[1].id).toBe('run-done-1');
    });

    it('searches by task name substring', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-digest', task: 'digest', started_at: now - 2 }));
      insertRun(makeRun({ id: 'run-curate', task: 'curate', started_at: now - 1 }));
      insertRun(makeRun({ id: 'run-digest-full', task: 'full-digest', started_at: now }));

      const rows = listRuns({ search: 'digest' });
      expect(rows).toHaveLength(2);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain('run-digest');
      expect(ids).toContain('run-digest-full');
    });

    it('combines search with status and pagination', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-a', task: 'digest', status: 'completed', started_at: now - 3 }));
      insertRun(makeRun({ id: 'run-b', task: 'digest', status: 'completed', started_at: now - 2 }));
      insertRun(makeRun({ id: 'run-c', task: 'digest', status: 'completed', started_at: now - 1 }));
      insertRun(makeRun({ id: 'run-d', task: 'curate', status: 'completed', started_at: now }));

      const rows = listRuns({ search: 'digest', status: 'completed', limit: 2, offset: 1 });
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('run-b');
      expect(rows[1].id).toBe('run-a');
    });

    it('filters by exact task name', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-digest', task: 'digest', started_at: now - 1 }));
      insertRun(makeRun({ id: 'run-full-digest', task: 'full-digest', started_at: now }));

      const rows = listRuns({ task: 'digest' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('run-digest');
    });
  });

  // ---------------------------------------------------------------------------
  // countRuns
  // ---------------------------------------------------------------------------

  describe('countRuns', () => {
    it('counts all runs when no filter given', async () => {
      insertRun(makeRun({ started_at: epochNow() }));
      insertRun(makeRun({ started_at: epochNow() }));
      insertRun(makeRun({ started_at: epochNow() }));

      expect(countRuns()).toBe(3);
    });

    it('counts zero when no runs exist', async () => {
      expect(countRuns()).toBe(0);
    });

    it('counts with status filter', async () => {
      insertRun(makeRun({ status: 'completed', started_at: epochNow() }));
      insertRun(makeRun({ status: 'completed', started_at: epochNow() }));
      insertRun(makeRun({ status: 'pending', started_at: epochNow() }));

      expect(countRuns({ status: 'completed' })).toBe(2);
      expect(countRuns({ status: 'pending' })).toBe(1);
    });

    it('counts with search filter', async () => {
      insertRun(makeRun({ task: 'digest', started_at: epochNow() }));
      insertRun(makeRun({ task: 'full-digest', started_at: epochNow() }));
      insertRun(makeRun({ task: 'curate', started_at: epochNow() }));

      expect(countRuns({ search: 'digest' })).toBe(2);
      expect(countRuns({ search: 'curate' })).toBe(1);
    });

    it('counts with exact task filter', async () => {
      insertRun(makeRun({ task: 'digest', started_at: epochNow() }));
      insertRun(makeRun({ task: 'full-digest', started_at: epochNow() }));

      expect(countRuns({ task: 'digest' })).toBe(1);
    });

    it('counts with combined filters', async () => {
      insertRun(makeRun({ task: 'digest', status: 'completed', started_at: epochNow() }));
      insertRun(makeRun({ task: 'digest', status: 'pending', started_at: epochNow() }));
      insertRun(makeRun({ task: 'curate', status: 'completed', started_at: epochNow() }));

      expect(countRuns({ search: 'digest', status: 'completed' })).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // updateRunStatus
  // ---------------------------------------------------------------------------

  describe('updateRunStatus', () => {
    it('updates status only', async () => {
      const data = makeRun({ started_at: epochNow() });
      insertRun(data);

      const updated = updateRunStatus(data.id, 'running');
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('running');
    });

    it('updates status with completion data', async () => {
      const now = epochNow();
      const data = makeRun({ started_at: now - 10 });
      insertRun(data);

      const updated = updateRunStatus(data.id, 'completed', {
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
      insertRun(data);

      const updated = updateRunStatus(data.id, 'failed', {
        error: 'LLM timeout',
        completed_at: epochNow(),
      });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('failed');
      expect(updated!.error).toBe('LLM timeout');
    });

    it('returns null for non-existent id', async () => {
      const updated = updateRunStatus('does-not-exist', 'running');
      expect(updated).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getRunningRun
  // ---------------------------------------------------------------------------

  describe('getRunningRun', () => {
    it('returns the running run for an agent', async () => {
      const data = makeRun({ status: 'running', started_at: epochNow() });
      insertRun(data);

      const running = getRunningRun(TEST_AGENT_ID);
      expect(running).not.toBeNull();
      expect(running!.id).toBe(data.id);
      expect(running!.status).toBe('running');
    });

    it('returns null when no run is running', async () => {
      insertRun(makeRun({ status: 'completed', started_at: epochNow() }));

      const running = getRunningRun(TEST_AGENT_ID);
      expect(running).toBeNull();
    });

    it('returns the most recent running run', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-old', status: 'running', started_at: now - 100 }));
      insertRun(makeRun({ id: 'run-new', status: 'running', started_at: now }));

      const running = getRunningRun(TEST_AGENT_ID);
      expect(running).not.toBeNull();
      expect(running!.id).toBe('run-new');
    });
  });

  // ---------------------------------------------------------------------------
  // dry_run + evaluation_id round-trip (I4)
  // ---------------------------------------------------------------------------

  describe('dryRun + evaluationId columns', () => {
    it('defaults dry_run to false and evaluation_id to null when omitted', () => {
      const row = insertRun(makeRun({ id: 'run-default' }));
      expect(row.dry_run).toBe(false);
      expect(row.evaluation_id).toBeNull();

      const fetched = getRun('run-default')!;
      expect(fetched.dry_run).toBe(false);
      expect(fetched.evaluation_id).toBeNull();
    });

    it('round-trips dryRun:true to dry_run === true on read', () => {
      const row = insertRun(makeRun({ id: 'run-dry', dryRun: true }));
      expect(row.dry_run).toBe(true);

      const fetched = getRun('run-dry')!;
      expect(fetched.dry_run).toBe(true);
    });

    it('round-trips evaluationId', () => {
      const row = insertRun(makeRun({ id: 'run-eval', evaluationId: 'eval-abc' }));
      expect(row.evaluation_id).toBe('eval-abc');
    });

    it('allows updating dryRun and evaluationId via updateRun', () => {
      insertRun(makeRun({ id: 'run-u' }));
      const updated = updateRun('run-u', { dryRun: true, evaluationId: 'eval-xyz' });
      expect(updated!.dry_run).toBe(true);
      expect(updated!.evaluation_id).toBe('eval-xyz');
    });

    it('can clear evaluationId by passing null', () => {
      insertRun(makeRun({ id: 'run-clear', evaluationId: 'eval-old' }));
      const cleared = updateRun('run-clear', { evaluationId: null });
      expect(cleared!.evaluation_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // reasoning_level + execution_overrides round-trip (v16)
  // ---------------------------------------------------------------------------

  describe('reasoningLevel + executionOverrides columns', () => {
    it('defaults reasoning_level and execution_overrides to null when omitted', () => {
      const row = insertRun(makeRun({ id: 'run-default-reasoning' }));
      expect(row.reasoning_level).toBeNull();
      expect(row.execution_overrides).toBeNull();

      const fetched = getRun('run-default-reasoning')!;
      expect(fetched.reasoning_level).toBeNull();
      expect(fetched.execution_overrides).toBeNull();
    });

    it('round-trips reasoningLevel and executionOverrides with phase overrides', () => {
      const overrides = {
        reasoningLevel: 'high',
        phases: { extract: { reasoningLevel: 'low' } },
      };
      const row = insertRun(makeRun({
        id: 'run-high',
        reasoningLevel: 'high',
        executionOverrides: overrides,
      }));
      expect(row.reasoning_level).toBe('high');
      expect(row.execution_overrides).toEqual(overrides);

      const fetched = getRun('run-high')!;
      expect(fetched.reasoning_level).toBe('high');
      expect(fetched.execution_overrides).toEqual(overrides);
    });

    it('allows updating reasoningLevel via updateRun', () => {
      insertRun(makeRun({ id: 'run-update-reasoning', reasoningLevel: 'low' }));
      const updated = updateRun('run-update-reasoning', { reasoningLevel: 'high' });
      expect(updated!.reasoning_level).toBe('high');
    });

    it('allows updating executionOverrides via updateRun', () => {
      insertRun(makeRun({ id: 'run-update-overrides' }));
      const nextOverrides = { runtime: 'claude-sdk', reasoningLevel: 'default' };
      const updated = updateRun('run-update-overrides', { executionOverrides: nextOverrides });
      expect(updated!.execution_overrides).toEqual(nextOverrides);
    });

    it('can clear reasoningLevel and executionOverrides by passing null', () => {
      insertRun(makeRun({
        id: 'run-clear-v16',
        reasoningLevel: 'high',
        executionOverrides: { reasoningLevel: 'high' },
      }));
      const cleared = updateRun('run-clear-v16', {
        reasoningLevel: null,
        executionOverrides: null,
      });
      expect(cleared!.reasoning_level).toBeNull();
      expect(cleared!.execution_overrides).toBeNull();
    });

    it('tolerates bogus JSON in execution_overrides column on read', async () => {
      // Seed a bogus value directly via the DB to simulate corruption.
      const { getDatabase } = await import('@myco/db/client.js');
      insertRun(makeRun({ id: 'run-corrupt' }));
      getDatabase().prepare(
        `UPDATE agent_runs SET execution_overrides = ? WHERE id = ?`,
      ).run('not-valid-json{', 'run-corrupt');

      const fetched = getRun('run-corrupt');
      expect(fetched).not.toBeNull();
      expect(fetched!.execution_overrides).toBeNull();
    });

    it('defaults dry_run to false when the column default is used', () => {
      // Pins the invariant: rows inserted without specifying dry_run come
      // back as `false` (the NOT NULL DEFAULT 0 column). The hydrator also
      // guards against NULL via `Boolean(Number(row.dry_run ?? 0))` so
      // legacy vaults with nullable dry_run columns still read false.
      insertRun(makeRun({ id: 'run-dry-default' }));
      const row = getRun('run-dry-default');
      expect(row!.dry_run).toBe(false);

      // Unit-check the coercion for the NULL case — a legacy row with
      // dry_run=NULL (possible in vaults upgraded through an earlier
      // schema) must still normalize to false.
      expect(Boolean(Number((null as number | null) ?? 0))).toBe(false);
    });
  });
});
