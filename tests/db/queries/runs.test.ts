/**
 * Tests for agent run CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
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
  getRunningRunForTask,
  incrementRunResumeAttempts,
  refundRunResumeAttempt,
} from '@myco/db/queries/runs.js';
import type { RunInsert } from '@myco/db/queries/runs.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

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

      const fetched = getRun(data.id, ALL_PROJECTS_SCOPE);
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
      const row = getRun('does-not-exist', ALL_PROJECTS_SCOPE);
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

      const rows = listRuns({ scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('run-new');
      expect(rows[1].id).toBe('run-mid');
      expect(rows[2].id).toBe('run-old');
    });

    it('orders a resumed run by its CURRENT attempt (resumed_at), not its original dispatch', () => {
      // started_at is preserved as the ORIGINAL dispatch time across resumes
      // (executor.ts) — a run dispatched long ago but resumed moments ago
      // must still surface near the top of the list, matching the rail's
      // recency section bucketing (RunList.tsx).
      const now = epochNow();
      insertRun(makeRun({ id: 'run-recent-fresh', started_at: now - 50 }));
      insertRun(makeRun({
        id: 'run-old-dispatch-just-resumed',
        started_at: now - 10_000,
        resumed_at: now,
      }));
      insertRun(makeRun({ id: 'run-oldest', started_at: now - 200 }));

      const rows = listRuns({ scope: ALL_PROJECTS_SCOPE });
      expect(rows.map((r) => r.id)).toEqual([
        'run-old-dispatch-just-resumed',
        'run-recent-fresh',
        'run-oldest',
      ]);
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

      const rows = listRuns({ agent_id: TEST_AGENT_ID, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('run-a');
    });

    it('filters by status', async () => {
      insertRun(makeRun({ id: 'run-pending', status: 'pending', started_at: epochNow() }));
      insertRun(makeRun({ id: 'run-running', status: 'running', started_at: epochNow() }));

      const rows = listRuns({ status: 'running', scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('run-running');
    });

    it('respects limit', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-1', started_at: now - 2 }));
      insertRun(makeRun({ id: 'run-2', started_at: now - 1 }));
      insertRun(makeRun({ id: 'run-3', started_at: now }));

      const rows = listRuns({ limit: 2, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(2);
    });

    it('returns empty array when no runs exist', async () => {
      const rows = listRuns({ scope: ALL_PROJECTS_SCOPE });
      expect(rows).toEqual([]);
    });

    it('paginates with offset', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-1', started_at: now - 2 }));
      insertRun(makeRun({ id: 'run-2', started_at: now - 1 }));
      insertRun(makeRun({ id: 'run-3', started_at: now }));

      // Page 1: first 2 rows
      const page1 = listRuns({ limit: 2, offset: 0, scope: ALL_PROJECTS_SCOPE });
      expect(page1).toHaveLength(2);
      expect(page1[0].id).toBe('run-3');
      expect(page1[1].id).toBe('run-2');

      // Page 2: remaining row
      const page2 = listRuns({ limit: 2, offset: 2, scope: ALL_PROJECTS_SCOPE });
      expect(page2).toHaveLength(1);
      expect(page2[0].id).toBe('run-1');
    });

    it('combines offset with status filter', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-done-1', status: 'completed', started_at: now - 3 }));
      insertRun(makeRun({ id: 'run-done-2', status: 'completed', started_at: now - 2 }));
      insertRun(makeRun({ id: 'run-done-3', status: 'completed', started_at: now - 1 }));
      insertRun(makeRun({ id: 'run-pending', status: 'pending', started_at: now }));

      const rows = listRuns({ status: 'completed', limit: 2, offset: 1, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('run-done-2');
      expect(rows[1].id).toBe('run-done-1');
    });

    it('searches by task name substring', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-digest', task: 'digest', started_at: now - 2 }));
      insertRun(makeRun({ id: 'run-curate', task: 'curate', started_at: now - 1 }));
      insertRun(makeRun({ id: 'run-digest-full', task: 'full-digest', started_at: now }));

      const rows = listRuns({ search: 'digest', scope: ALL_PROJECTS_SCOPE });
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

      const rows = listRuns({ search: 'digest', status: 'completed', limit: 2, offset: 1, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('run-b');
      expect(rows[1].id).toBe('run-a');
    });

    it('filters by exact task name', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-digest', task: 'digest', started_at: now - 1 }));
      insertRun(makeRun({ id: 'run-full-digest', task: 'full-digest', started_at: now }));

      const rows = listRuns({ task: 'digest', scope: ALL_PROJECTS_SCOPE });
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

      expect(countRuns({ scope: ALL_PROJECTS_SCOPE })).toBe(3);
    });

    it('counts zero when no runs exist', async () => {
      expect(countRuns({ scope: ALL_PROJECTS_SCOPE })).toBe(0);
    });

    it('counts with status filter', async () => {
      insertRun(makeRun({ status: 'completed', started_at: epochNow() }));
      insertRun(makeRun({ status: 'completed', started_at: epochNow() }));
      insertRun(makeRun({ status: 'pending', started_at: epochNow() }));

      expect(countRuns({ status: 'completed', scope: ALL_PROJECTS_SCOPE })).toBe(2);
      expect(countRuns({ status: 'pending', scope: ALL_PROJECTS_SCOPE })).toBe(1);
    });

    it('counts with search filter', async () => {
      insertRun(makeRun({ task: 'digest', started_at: epochNow() }));
      insertRun(makeRun({ task: 'full-digest', started_at: epochNow() }));
      insertRun(makeRun({ task: 'curate', started_at: epochNow() }));

      expect(countRuns({ search: 'digest', scope: ALL_PROJECTS_SCOPE })).toBe(2);
      expect(countRuns({ search: 'curate', scope: ALL_PROJECTS_SCOPE })).toBe(1);
    });

    it('counts with exact task filter', async () => {
      insertRun(makeRun({ task: 'digest', started_at: epochNow() }));
      insertRun(makeRun({ task: 'full-digest', started_at: epochNow() }));

      expect(countRuns({ task: 'digest', scope: ALL_PROJECTS_SCOPE })).toBe(1);
    });

    it('counts with combined filters', async () => {
      insertRun(makeRun({ task: 'digest', status: 'completed', started_at: epochNow() }));
      insertRun(makeRun({ task: 'digest', status: 'pending', started_at: epochNow() }));
      insertRun(makeRun({ task: 'curate', status: 'completed', started_at: epochNow() }));

      expect(countRuns({ search: 'digest', status: 'completed', scope: ALL_PROJECTS_SCOPE })).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // updateRunStatus
  // ---------------------------------------------------------------------------

  describe('updateRunStatus', () => {
    it('updates status only', async () => {
      const data = makeRun({ started_at: epochNow() });
      insertRun(data);

      const updated = updateRunStatus(data.id, 'running', undefined, ALL_PROJECTS_SCOPE);
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
      }, ALL_PROJECTS_SCOPE);
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
      }, ALL_PROJECTS_SCOPE);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('failed');
      expect(updated!.error).toBe('LLM timeout');
    });

    it('returns null for non-existent id', async () => {
      const updated = updateRunStatus('does-not-exist', 'running', undefined, ALL_PROJECTS_SCOPE);
      expect(updated).toBeNull();
    });

    it('ignores started_at on an update — the column is structurally immutable once inserted', async () => {
      // started_at is a run's ORIGINAL dispatch time (executor.ts) and must
      // never move after insertRun. UPDATE_COLUMNS deliberately omits it, so
      // buildUpdateClauses silently drops the key rather than emitting a SET
      // clause for it — this pins that dropped-key behavior structurally,
      // not just by caller discipline.
      const now = epochNow();
      const original = now - 10_000;
      const data = makeRun({ started_at: original });
      insertRun(data);

      // Cast through RunUpdate's index signature is unnecessary — started_at
      // is a legitimate (if inert) RunUpdate field — but the update also
      // carries a real field so we can confirm the update otherwise applies.
      const updated = updateRun(data.id, { started_at: now, status: 'completed' }, ALL_PROJECTS_SCOPE);

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.started_at).toBe(original);

      const reread = getRun(data.id, ALL_PROJECTS_SCOPE)!;
      expect(reread.started_at).toBe(original);
    });
  });

  // ---------------------------------------------------------------------------
  // getRunningRun
  // ---------------------------------------------------------------------------

  describe('getRunningRun', () => {
    it('returns the running run for an agent', async () => {
      const data = makeRun({ status: 'running', started_at: epochNow() });
      insertRun(data);

      const running = getRunningRun(TEST_AGENT_ID, ALL_PROJECTS_SCOPE);
      expect(running).not.toBeNull();
      expect(running!.id).toBe(data.id);
      expect(running!.status).toBe('running');
    });

    it('returns null when no run is running', async () => {
      insertRun(makeRun({ status: 'completed', started_at: epochNow() }));

      const running = getRunningRun(TEST_AGENT_ID, ALL_PROJECTS_SCOPE);
      expect(running).toBeNull();
    });

    it('returns the most recent running run', async () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-old', status: 'running', started_at: now - 100 }));
      insertRun(makeRun({ id: 'run-new', status: 'running', started_at: now }));

      const running = getRunningRun(TEST_AGENT_ID, ALL_PROJECTS_SCOPE);
      expect(running).not.toBeNull();
      expect(running!.id).toBe('run-new');
    });

    it('picks a resumed run by its CURRENT attempt (resumed_at), not its original dispatch', async () => {
      const now = epochNow();
      // run-resumed was dispatched long ago (T0) but its resume attempt (T2)
      // is the most recent activity; run-fresh was dispatched at T1, strictly
      // between T0 and T2, and never resumed. A started_at-only ORDER BY
      // would incorrectly pick run-fresh.
      insertRun(makeRun({ id: 'run-resumed', status: 'running', started_at: now - 10_000, resumed_at: now - 100 }));
      insertRun(makeRun({ id: 'run-fresh', status: 'running', started_at: now - 5_000 }));

      const running = getRunningRun(TEST_AGENT_ID, ALL_PROJECTS_SCOPE);
      expect(running).not.toBeNull();
      expect(running!.id).toBe('run-resumed');
    });
  });

  // ---------------------------------------------------------------------------
  // dry_run round-trip (I4). The sibling evaluation_id column was retired
  // in schema v24 alongside the matrix-evaluation feature.
  // ---------------------------------------------------------------------------

  describe('dryRun column', () => {
    it('defaults dry_run to false when omitted', () => {
      const row = insertRun(makeRun({ id: 'run-default' }));
      expect(row.dry_run).toBe(false);

      const fetched = getRun('run-default', ALL_PROJECTS_SCOPE)!;
      expect(fetched.dry_run).toBe(false);
    });

    it('round-trips dryRun:true to dry_run === true on read', () => {
      const row = insertRun(makeRun({ id: 'run-dry', dryRun: true }));
      expect(row.dry_run).toBe(true);

      const fetched = getRun('run-dry', ALL_PROJECTS_SCOPE)!;
      expect(fetched.dry_run).toBe(true);
    });

    it('allows updating dryRun via updateRun', () => {
      insertRun(makeRun({ id: 'run-u' }));
      const updated = updateRun('run-u', { dryRun: true }, ALL_PROJECTS_SCOPE);
      expect(updated!.dry_run).toBe(true);
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

      const fetched = getRun('run-default-reasoning', ALL_PROJECTS_SCOPE)!;
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

      const fetched = getRun('run-high', ALL_PROJECTS_SCOPE)!;
      expect(fetched.reasoning_level).toBe('high');
      expect(fetched.execution_overrides).toEqual(overrides);
    });

    it('allows updating reasoningLevel via updateRun', () => {
      insertRun(makeRun({ id: 'run-update-reasoning', reasoningLevel: 'low' }));
      const updated = updateRun('run-update-reasoning', { reasoningLevel: 'high' }, ALL_PROJECTS_SCOPE);
      expect(updated!.reasoning_level).toBe('high');
    });

    it('allows updating executionOverrides via updateRun', () => {
      insertRun(makeRun({ id: 'run-update-overrides' }));
      const nextOverrides = { harness: 'claude-sdk', reasoningLevel: 'default' };
      const updated = updateRun('run-update-overrides', { executionOverrides: nextOverrides }, ALL_PROJECTS_SCOPE);
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
      }, ALL_PROJECTS_SCOPE);
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

      const fetched = getRun('run-corrupt', ALL_PROJECTS_SCOPE);
      expect(fetched).not.toBeNull();
      expect(fetched!.execution_overrides).toBeNull();
    });

    it('defaults dry_run to false when the column default is used', () => {
      // Rows inserted without specifying dry_run come back as `false` (the
      // NOT NULL DEFAULT 0 column). The hydrator uses `Boolean(Number(row.dry_run ?? 0))`
      // to also normalize legacy rows with nullable dry_run columns to false.
      insertRun(makeRun({ id: 'run-dry-default' }));
      const row = getRun('run-dry-default', ALL_PROJECTS_SCOPE);
      expect(row!.dry_run).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // resume_attempts + run_context (v60)
  // ---------------------------------------------------------------------------

  describe('resume_attempts + run_context columns', () => {
    it('defaults resume_attempts to 0 and run_context to null when omitted', () => {
      const row = insertRun(makeRun({ id: 'run-v60-default' }));
      expect(row.resume_attempts).toBe(0);
      expect(row.run_context).toBeNull();
    });

    it('round-trips run_context JSON', () => {
      const context = JSON.stringify({ candidate_id: 'cand-1', skill_survey_watermark: 42 });
      const row = insertRun(makeRun({ id: 'run-ctx', run_context: context }));
      expect(row.run_context).toBe(context);

      const fetched = getRun('run-ctx', ALL_PROJECTS_SCOPE)!;
      expect(fetched.run_context).toBe(context);
    });

    it('incrementRunResumeAttempts bumps the counter atomically', () => {
      insertRun(makeRun({ id: 'run-attempts' }));

      expect(incrementRunResumeAttempts('run-attempts', ALL_PROJECTS_SCOPE)).toBe(1);
      expect(incrementRunResumeAttempts('run-attempts', ALL_PROJECTS_SCOPE)).toBe(1);
      expect(getRun('run-attempts', ALL_PROJECTS_SCOPE)!.resume_attempts).toBe(2);
    });

    it('incrementRunResumeAttempts returns 0 for a missing run', () => {
      expect(incrementRunResumeAttempts('does-not-exist', ALL_PROJECTS_SCOPE)).toBe(0);
    });

    it('refundRunResumeAttempt decrements and floors at 0', () => {
      insertRun(makeRun({ id: 'run-refund' }));
      incrementRunResumeAttempts('run-refund', ALL_PROJECTS_SCOPE);
      incrementRunResumeAttempts('run-refund', ALL_PROJECTS_SCOPE);

      expect(refundRunResumeAttempt('run-refund', ALL_PROJECTS_SCOPE)).toBe(1);
      expect(getRun('run-refund', ALL_PROJECTS_SCOPE)!.resume_attempts).toBe(1);

      refundRunResumeAttempt('run-refund', ALL_PROJECTS_SCOPE);
      refundRunResumeAttempt('run-refund', ALL_PROJECTS_SCOPE);
      expect(getRun('run-refund', ALL_PROJECTS_SCOPE)!.resume_attempts).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getRunningRunForTask staleness
  // ---------------------------------------------------------------------------

  describe('getRunningRunForTask', () => {
    it('returns the newest running run for the task with stale=false when no cutoff given', () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-old', task: 'digest', status: 'running', started_at: now - 100 }));
      insertRun(makeRun({ id: 'run-new', task: 'digest', status: 'running', started_at: now }));

      const running = getRunningRunForTask(TEST_AGENT_ID, 'digest', ALL_PROJECTS_SCOPE);
      expect(running).not.toBeNull();
      expect(running!.id).toBe('run-new');
      expect(running!.stale).toBe(false);
    });

    it('returns null when no run is running for the task', () => {
      insertRun(makeRun({ id: 'run-done', task: 'digest', status: 'completed', started_at: epochNow() }));
      expect(getRunningRunForTask(TEST_AGENT_ID, 'digest', ALL_PROJECTS_SCOPE)).toBeNull();
    });

    it('flags a running row older than maxAgeSeconds as stale without mutating it', () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-stale', task: 'digest', status: 'running', started_at: now - 10_000 }));

      const running = getRunningRunForTask(TEST_AGENT_ID, 'digest', ALL_PROJECTS_SCOPE, 600);
      expect(running).not.toBeNull();
      expect(running!.id).toBe('run-stale');
      expect(running!.stale).toBe(true);

      // Boot recovery owns marking orphans — the read must not mutate.
      const row = getRun('run-stale', ALL_PROJECTS_SCOPE)!;
      expect(row.status).toBe('running');
    });

    it('keeps a recent running row fresh under the same cutoff', () => {
      const now = epochNow();
      insertRun(makeRun({ id: 'run-fresh', task: 'digest', status: 'running', started_at: now - 30 }));

      const running = getRunningRunForTask(TEST_AGENT_ID, 'digest', ALL_PROJECTS_SCOPE, 600);
      expect(running!.stale).toBe(false);
    });

    it('treats a long-dormant run as fresh once resumed — stale is judged off the CURRENT attempt, not the original dispatch', () => {
      // started_at is preserved as the run's ORIGINAL dispatch time across
      // resumes (executor.ts) — a resume dispatched long after that time
      // must not immediately read as a stale zombie row just because its
      // first attempt was old.
      const now = epochNow();
      insertRun(makeRun({
        id: 'run-resumed-fresh',
        task: 'digest',
        status: 'running',
        started_at: now - 10_000,
        resumed_at: now - 5,
      }));

      const running = getRunningRunForTask(TEST_AGENT_ID, 'digest', ALL_PROJECTS_SCOPE, 600);
      expect(running).not.toBeNull();
      expect(running!.id).toBe('run-resumed-fresh');
      expect(running!.stale).toBe(false);
    });

    it('still flags a resumed run as stale once its CURRENT attempt (resumed_at) exceeds the cutoff', () => {
      const now = epochNow();
      insertRun(makeRun({
        id: 'run-resumed-stale',
        task: 'digest',
        status: 'running',
        started_at: now - 20_000,
        resumed_at: now - 10_000,
      }));

      const running = getRunningRunForTask(TEST_AGENT_ID, 'digest', ALL_PROJECTS_SCOPE, 600);
      expect(running!.stale).toBe(true);
    });
  });
});
