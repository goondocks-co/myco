/**
 * Tests for the agent_run_evaluations query helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun, listRunsForEvaluation } from '@myco/db/queries/runs.js';
import {
  insertEvaluation,
  getEvaluation,
  listEvaluations,
  updateEvaluationStatus,
  EVAL_STATUS_COMPLETED,
  EVAL_STATUS_RUNNING,
  EVAL_STATUS_FAILED,
} from '@myco/db/queries/evaluations.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const TEST_AGENT_ID = 'agent-evaluations-test';

describe('evaluation query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: TEST_AGENT_ID, name: 'Test', created_at: epochNow() });
  });

  describe('insertEvaluation + getEvaluation', () => {
    it('stores the matrix as JSON and parses it back on read', () => {
      const matrix = {
        runtimes: ['claude', 'openai'],
        reasoning: ['normal', 'thinking'],
        models: ['claude-opus-4-7', 'gpt-5'],
        dryRun: [true, false],
      };

      const inserted = insertEvaluation({
        id: 'eval-1',
        taskId: 'full-intelligence',
        matrix,
        notes: 'quick A/B',
      });

      expect(inserted.id).toBe('eval-1');
      expect(inserted.task_id).toBe('full-intelligence');
      expect(inserted.matrix).toEqual(matrix);
      expect(inserted.notes).toBe('quick A/B');
      expect(inserted.status).toBe('pending');
      expect(inserted.completed_at).toBeNull();

      const fetched = getEvaluation('eval-1');
      expect(fetched).not.toBeNull();
      expect(fetched!.matrix).toEqual(matrix);
    });

    it('returns null for unknown id', () => {
      expect(getEvaluation('does-not-exist')).toBeNull();
    });

    it('accepts null notes', () => {
      const row = insertEvaluation({ id: 'eval-no-notes', taskId: 't', matrix: {} });
      expect(row.notes).toBeNull();
    });

    it('honours created_at override', () => {
      const row = insertEvaluation({ id: 'eval-ts', taskId: 't', matrix: {}, createdAt: 1000 });
      expect(row.created_at).toBe(1000);
    });
  });

  describe('listEvaluations', () => {
    it('returns newest first', () => {
      insertEvaluation({ id: 'eval-a', taskId: 't', matrix: {}, createdAt: 100 });
      insertEvaluation({ id: 'eval-b', taskId: 't', matrix: {}, createdAt: 200 });
      insertEvaluation({ id: 'eval-c', taskId: 't', matrix: {}, createdAt: 150 });

      const rows = listEvaluations();
      expect(rows.map((r) => r.id)).toEqual(['eval-b', 'eval-c', 'eval-a']);
    });

    it('applies limit and offset', () => {
      insertEvaluation({ id: 'eval-a', taskId: 't', matrix: {}, createdAt: 100 });
      insertEvaluation({ id: 'eval-b', taskId: 't', matrix: {}, createdAt: 200 });
      insertEvaluation({ id: 'eval-c', taskId: 't', matrix: {}, createdAt: 300 });

      const first = listEvaluations({ limit: 1 });
      expect(first.map((r) => r.id)).toEqual(['eval-c']);

      const page2 = listEvaluations({ limit: 1, offset: 1 });
      expect(page2.map((r) => r.id)).toEqual(['eval-b']);
    });
  });

  describe('updateEvaluationStatus', () => {
    it('updates status without touching completed_at when omitted', () => {
      insertEvaluation({ id: 'eval-1', taskId: 't', matrix: {} });
      const updated = updateEvaluationStatus('eval-1', EVAL_STATUS_RUNNING);
      expect(updated!.status).toBe('running');
      expect(updated!.completed_at).toBeNull();
    });

    it('stamps completed_at when supplied', () => {
      insertEvaluation({ id: 'eval-2', taskId: 't', matrix: {} });
      const updated = updateEvaluationStatus('eval-2', EVAL_STATUS_COMPLETED, 9999);
      expect(updated!.status).toBe('completed');
      expect(updated!.completed_at).toBe(9999);
    });

    it('accepts null completed_at to explicitly clear', () => {
      insertEvaluation({ id: 'eval-3', taskId: 't', matrix: {} });
      updateEvaluationStatus('eval-3', EVAL_STATUS_COMPLETED, 1000);
      const cleared = updateEvaluationStatus('eval-3', EVAL_STATUS_FAILED, null);
      expect(cleared!.completed_at).toBeNull();
    });
  });

  describe('listRunsForEvaluation', () => {
    it('returns all runs linked to an evaluation, newest first', () => {
      insertEvaluation({ id: 'eval-runs', taskId: 'full-intelligence', matrix: {} });

      insertRun({
        id: 'run-1',
        agent_id: TEST_AGENT_ID,
        evaluationId: 'eval-runs',
        started_at: 100,
      });
      insertRun({
        id: 'run-2',
        agent_id: TEST_AGENT_ID,
        evaluationId: 'eval-runs',
        started_at: 200,
      });
      // Unlinked run must not appear
      insertRun({
        id: 'run-other',
        agent_id: TEST_AGENT_ID,
        started_at: 500,
      });

      const runs = listRunsForEvaluation('eval-runs');
      expect(runs.map((r) => r.id)).toEqual(['run-2', 'run-1']);
      expect(runs.every((r) => r.evaluation_id === 'eval-runs')).toBe(true);
    });

    it('returns an empty array for an evaluation with no runs', () => {
      insertEvaluation({ id: 'eval-empty', taskId: 't', matrix: {} });
      expect(listRunsForEvaluation('eval-empty')).toEqual([]);
    });
  });
});
