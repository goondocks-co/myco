/**
 * Tests for the agent_run_write_intents query helpers.
 *
 * Each test uses the shared in-memory SQLite test database. Write intents
 * are scoped per agent_run, so every test registers an agent + run first.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import {
  insertWriteIntent,
  listWriteIntents,
  countWriteIntentsByTool,
  countWriteIntentsByToolForEvaluation,
} from '@myco/db/queries/write-intents.js';
import { insertEvaluation } from '@myco/db/queries/evaluations.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const TEST_AGENT_ID = 'agent-write-intents-test';

function seedRun(id: string) {
  insertRun({
    id,
    agent_id: TEST_AGENT_ID,
    task: 'vault-evolve',
    started_at: epochNow(),
  });
}

describe('write intents query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: TEST_AGENT_ID, name: 'Test', created_at: epochNow() });
  });

  describe('insertWriteIntent', () => {
    it('inserts a row and returns the autoincrement id', () => {
      seedRun('run-1');
      const id = insertWriteIntent({
        runId: 'run-1',
        phaseId: 'phase-a',
        toolName: 'vault_create_spore',
        toolInput: JSON.stringify({ content: 'hello' }),
        syntheticOutput: JSON.stringify({ id: 'stub-123' }),
        stubId: 'stub-123',
      });
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    it('allows null phase_id and null stub_id', () => {
      seedRun('run-2');
      const id = insertWriteIntent({
        runId: 'run-2',
        toolName: 'vault_mark_processed',
        toolInput: '{}',
        syntheticOutput: '{}',
      });
      const rows = listWriteIntents('run-2');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
      expect(rows[0].phase_id).toBeNull();
      expect(rows[0].stub_id).toBeNull();
    });

    it('parses tool_input and synthetic_output JSON on read', () => {
      seedRun('run-json');
      insertWriteIntent({
        runId: 'run-json',
        toolName: 'vault_create_spore',
        toolInput: JSON.stringify({ content: 'hi', importance: 7 }),
        syntheticOutput: JSON.stringify({ id: 'stub-1', ok: true }),
      });
      const [row] = listWriteIntents('run-json');
      expect(row.tool_input).toEqual({ content: 'hi', importance: 7 });
      expect(row.synthetic_output).toEqual({ id: 'stub-1', ok: true });
    });

    it('records epoch seconds by default and honours recordedAt override', () => {
      seedRun('run-3');
      const before = epochNow();
      insertWriteIntent({
        runId: 'run-3',
        toolName: 'x',
        toolInput: '{}',
        syntheticOutput: '{}',
      });
      insertWriteIntent({
        runId: 'run-3',
        toolName: 'y',
        toolInput: '{}',
        syntheticOutput: '{}',
        recordedAt: 1234,
      });
      const rows = listWriteIntents('run-3');
      expect(rows[0].recorded_at).toBeGreaterThanOrEqual(before);
      expect(rows[1].recorded_at).toBe(1234);
    });
  });

  describe('listWriteIntents', () => {
    it('returns all intents for a run in insertion order', () => {
      seedRun('run-list');
      insertWriteIntent({ runId: 'run-list', toolName: 'a', toolInput: '1', syntheticOutput: '1' });
      insertWriteIntent({ runId: 'run-list', toolName: 'b', toolInput: '2', syntheticOutput: '2' });
      insertWriteIntent({ runId: 'run-list', toolName: 'c', toolInput: '3', syntheticOutput: '3' });

      const rows = listWriteIntents('run-list');
      expect(rows.map((r) => r.tool_name)).toEqual(['a', 'b', 'c']);
    });

    it('does not leak intents across runs', () => {
      seedRun('run-x');
      seedRun('run-y');
      insertWriteIntent({ runId: 'run-x', toolName: 'a', toolInput: '{}', syntheticOutput: '{}' });
      insertWriteIntent({ runId: 'run-y', toolName: 'b', toolInput: '{}', syntheticOutput: '{}' });

      expect(listWriteIntents('run-x').map((r) => r.tool_name)).toEqual(['a']);
      expect(listWriteIntents('run-y').map((r) => r.tool_name)).toEqual(['b']);
    });

    it('returns empty array when run has no intents', () => {
      seedRun('run-empty');
      expect(listWriteIntents('run-empty')).toEqual([]);
    });
  });

  describe('countWriteIntentsByTool', () => {
    it('groups counts by tool_name', () => {
      seedRun('run-count');
      insertWriteIntent({ runId: 'run-count', toolName: 'vault_create_spore', toolInput: '{}', syntheticOutput: '{}' });
      insertWriteIntent({ runId: 'run-count', toolName: 'vault_create_spore', toolInput: '{}', syntheticOutput: '{}' });
      insertWriteIntent({ runId: 'run-count', toolName: 'vault_create_spore', toolInput: '{}', syntheticOutput: '{}' });
      insertWriteIntent({ runId: 'run-count', toolName: 'vault_write_digest', toolInput: '{}', syntheticOutput: '{}' });

      const counts = countWriteIntentsByTool('run-count');
      expect(counts).toEqual({
        vault_create_spore: 3,
        vault_write_digest: 1,
      });
    });

    it('returns an empty object when there are no intents', () => {
      seedRun('run-zero');
      expect(countWriteIntentsByTool('run-zero')).toEqual({});
    });
  });

  describe('countWriteIntentsByToolForEvaluation', () => {
    function seedRunInEval(runId: string, evaluationId: string) {
      insertRun({
        id: runId,
        agent_id: TEST_AGENT_ID,
        task: 'vault-evolve',
        started_at: epochNow(),
        evaluationId,
      });
    }

    it('groups counts by run_id and tool_name across all runs in an evaluation', () => {
      insertEvaluation({ id: 'eval-batch', taskId: 'vault-evolve', matrix: {} });
      seedRunInEval('eval-batch-run-1', 'eval-batch');
      seedRunInEval('eval-batch-run-2', 'eval-batch');

      insertWriteIntent({ runId: 'eval-batch-run-1', toolName: 'vault_create_spore', toolInput: '{}', syntheticOutput: '{}' });
      insertWriteIntent({ runId: 'eval-batch-run-1', toolName: 'vault_create_spore', toolInput: '{}', syntheticOutput: '{}' });
      insertWriteIntent({ runId: 'eval-batch-run-1', toolName: 'vault_write_digest', toolInput: '{}', syntheticOutput: '{}' });

      insertWriteIntent({ runId: 'eval-batch-run-2', toolName: 'vault_create_spore', toolInput: '{}', syntheticOutput: '{}' });

      const byRun = countWriteIntentsByToolForEvaluation('eval-batch');
      expect(byRun).toEqual({
        'eval-batch-run-1': { vault_create_spore: 2, vault_write_digest: 1 },
        'eval-batch-run-2': { vault_create_spore: 1 },
      });
    });

    it('excludes runs that belong to other evaluations', () => {
      insertEvaluation({ id: 'eval-iso-a', taskId: 'vault-evolve', matrix: {} });
      insertEvaluation({ id: 'eval-iso-b', taskId: 'vault-evolve', matrix: {} });
      seedRunInEval('iso-run-a', 'eval-iso-a');
      seedRunInEval('iso-run-b', 'eval-iso-b');

      insertWriteIntent({ runId: 'iso-run-a', toolName: 't1', toolInput: '{}', syntheticOutput: '{}' });
      insertWriteIntent({ runId: 'iso-run-b', toolName: 't2', toolInput: '{}', syntheticOutput: '{}' });

      expect(countWriteIntentsByToolForEvaluation('eval-iso-a')).toEqual({
        'iso-run-a': { t1: 1 },
      });
    });

    it('returns an empty object for an evaluation with no child runs', () => {
      insertEvaluation({ id: 'eval-no-runs', taskId: 'vault-evolve', matrix: {} });
      expect(countWriteIntentsByToolForEvaluation('eval-no-runs')).toEqual({});
    });

    it('omits runs that have no intents', () => {
      insertEvaluation({ id: 'eval-mixed', taskId: 'vault-evolve', matrix: {} });
      seedRunInEval('mixed-run-1', 'eval-mixed');
      seedRunInEval('mixed-run-2', 'eval-mixed');
      insertWriteIntent({ runId: 'mixed-run-1', toolName: 't', toolInput: '{}', syntheticOutput: '{}' });

      const byRun = countWriteIntentsByToolForEvaluation('eval-mixed');
      expect(byRun).toEqual({ 'mixed-run-1': { t: 1 } });
    });
  });

  // ---------------------------------------------------------------------------
  // FK pinning (I5): agent_run_write_intents.run_id is ON DELETE CASCADE.
  // Pinned so the contract doesn't silently drift to SET NULL / NO ACTION.
  // ---------------------------------------------------------------------------

  describe('FK behaviour', () => {
    it('rejects inserts that reference an unknown run (FOREIGN KEY constraint)', () => {
      expect(() =>
        insertWriteIntent({
          runId: 'run-does-not-exist',
          toolName: 'vault_create_spore',
          toolInput: '{}',
          syntheticOutput: '{}',
        }),
      ).toThrow(/FOREIGN KEY/i);
    });

    it('CASCADEs write-intent deletions when the parent run is deleted', async () => {
      seedRun('run-cascade');
      insertWriteIntent({ runId: 'run-cascade', toolName: 'a', toolInput: '{}', syntheticOutput: '{}' });
      insertWriteIntent({ runId: 'run-cascade', toolName: 'b', toolInput: '{}', syntheticOutput: '{}' });
      expect(listWriteIntents('run-cascade')).toHaveLength(2);

      const { getDatabase } = await import('@myco/db/client.js');
      getDatabase().prepare('DELETE FROM agent_runs WHERE id = ?').run('run-cascade');

      expect(listWriteIntents('run-cascade')).toEqual([]);
    });
  });
});
