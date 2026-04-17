/**
 * Tests for agent-evaluations API — matrix cell enumeration, POST fan-out,
 * and the GET aggregate shape.
 *
 * The real `runAgent` is stubbed so we can assert fan-out without spinning
 * up the executor. Cells still need to land in agent_runs for the GET to
 * return populated children — the stub inserts a matching run row.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertWriteIntent } from '@myco/db/queries/write-intents.js';
import { getEvaluation } from '@myco/db/queries/evaluations.js';
import { createAgentEvaluationHandlers, enumerateMatrixCells } from '@myco/daemon/api/agent-evaluations';
import type { RouteRequest } from '@myco/daemon/router';

const epochNow = () => Math.floor(Date.now() / 1000);

const runAgentSpy = vi.fn();
vi.mock('@myco/agent/executor.js', () => ({
  runAgent: (...args: unknown[]) => runAgentSpy(...args),
}));

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { params: {}, query: {}, body: undefined, pathname: '/', ...overrides } as RouteRequest;
}

function makeHandlers() {
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };
  return createAgentEvaluationHandlers({
    vaultDir: '/tmp/fake-vault',
    embeddingManager: {} as never,
    logger: logger as never,
  });
}

// Wait for the fire-and-forget fan-out to settle. The handler kicks off
// a dynamic import of the executor then runs cells sequentially; a few
// microtask flushes are enough because the stub resolves synchronously.
async function flushMicrotasks(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

describe('enumerateMatrixCells', () => {
  it('returns a single cell when all dimensions are empty', () => {
    expect(enumerateMatrixCells({})).toEqual([
      { runtime: undefined, reasoningLevel: undefined, model: undefined },
    ]);
  });

  it('enumerates the cartesian product of populated dimensions', () => {
    const cells = enumerateMatrixCells({
      runtimes: ['claude-sdk', 'openai-agents'],
      reasoningLevels: ['low', 'high'],
    });
    expect(cells).toHaveLength(4);
    const keys = cells.map((c) => `${c.runtime}/${c.reasoningLevel}/${c.model}`);
    expect(new Set(keys).size).toBe(4);
  });

  it('treats an empty array the same as a missing dimension', () => {
    const cells = enumerateMatrixCells({ runtimes: [], reasoningLevels: ['low'] });
    expect(cells).toEqual([
      { runtime: undefined, reasoningLevel: 'low', model: undefined },
    ]);
  });
});

describe('agent-evaluations API', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    runAgentSpy.mockReset();
    registerAgent({ id: 'myco-agent', name: 'Test', created_at: epochNow() });
  });

  describe('handleCreate', () => {
    it('creates the evaluation + responds immediately with cellCount', async () => {
      runAgentSpy.mockImplementation(async () => ({ runId: 'r', status: 'completed' }));
      const { handleCreate } = makeHandlers();

      const res = await handleCreate(makeRequest({
        body: {
          taskId: 'full-intelligence',
          matrix: {
            runtimes: ['claude-sdk', 'openai-agents'],
            reasoningLevels: ['low', 'high'],
            dryRun: true,
          },
        },
      }));

      const body = res.body as { evaluationId: string; cellCount: number };
      expect(body.cellCount).toBe(4);
      expect(body.evaluationId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('defaults to a single cell when no dimensions are set', async () => {
      runAgentSpy.mockImplementation(async () => ({ runId: 'r', status: 'completed' }));
      const { handleCreate } = makeHandlers();

      const res = await handleCreate(makeRequest({
        body: { taskId: 'full-intelligence', matrix: {} },
      }));
      expect((res.body as { cellCount: number }).cellCount).toBe(1);
    });

    it('rejects a missing taskId with 400', async () => {
      const { handleCreate } = makeHandlers();
      const res = await handleCreate(makeRequest({ body: { matrix: {} } }));
      expect(res.status).toBe(400);
    });

    it('transitions the evaluation to running before the first cell completes', async () => {
      // Hold the first cell open with a manual-resolve promise so we can
      // observe the pending → running transition without racing the
      // fire-and-forget fan-out to completion.
      let releaseFirstCell: (() => void) | undefined;
      const firstCellGate = new Promise<void>((resolve) => { releaseFirstCell = resolve; });

      runAgentSpy.mockImplementation(async () => {
        await firstCellGate;
        return { runId: 'r', status: 'completed' };
      });

      const { handleCreate } = makeHandlers();
      const created = await handleCreate(makeRequest({
        body: { taskId: 'full-intelligence', matrix: {} },
      }));
      const { evaluationId } = created.body as { evaluationId: string };

      // Let the async IIFE pick up the task and hit the status update.
      await flushMicrotasks(40);

      const midRun = getEvaluation(evaluationId);
      expect(midRun?.status).toBe('running');

      // Let the fan-out finish so the test doesn't leak a pending promise.
      releaseFirstCell?.();
      await flushMicrotasks(40);
    });

    it('fires one runAgent per cell with the expected executionOverrides', async () => {
      const observedOverrides: unknown[] = [];
      runAgentSpy.mockImplementation(async (_vaultDir: string, opts: { executionOverrides?: unknown }) => {
        observedOverrides.push(opts.executionOverrides);
        return { runId: `r-${observedOverrides.length}`, status: 'completed' };
      });

      const { handleCreate } = makeHandlers();
      await handleCreate(makeRequest({
        body: {
          taskId: 'full-intelligence',
          matrix: {
            runtimes: ['claude-sdk'],
            reasoningLevels: ['low', 'high'],
            models: ['m1'],
          },
        },
      }));

      await flushMicrotasks(40);
      expect(runAgentSpy).toHaveBeenCalledTimes(2);
      expect(observedOverrides).toEqual([
        { runtime: 'claude-sdk', reasoningLevel: 'low', model: 'm1' },
        { runtime: 'claude-sdk', reasoningLevel: 'high', model: 'm1' },
      ]);
    });

    it('propagates matrix.phases into every cell executionOverrides', async () => {
      const observedOverrides: Array<Record<string, unknown>> = [];
      runAgentSpy.mockImplementation(async (_vaultDir: string, opts: { executionOverrides?: Record<string, unknown> }) => {
        observedOverrides.push(opts.executionOverrides ?? {});
        return { runId: `r-${observedOverrides.length}`, status: 'completed' };
      });

      const { handleCreate } = makeHandlers();
      await handleCreate(makeRequest({
        body: {
          taskId: 'full-intelligence',
          matrix: {
            runtimes: ['claude-sdk'],
            reasoningLevels: ['low', 'high'],
            phases: {
              extract: { reasoningLevel: 'low' },
              digest: { model: 'claude-haiku-4-5' },
            },
          },
        },
      }));

      await flushMicrotasks(40);
      expect(runAgentSpy).toHaveBeenCalledTimes(2);
      // Every cell carries the shared phases overlay in addition to its
      // own cell-level runtime/reasoning dimensions.
      for (const overrides of observedOverrides) {
        expect(overrides.phases).toEqual({
          extract: { reasoningLevel: 'low' },
          digest: { model: 'claude-haiku-4-5' },
        });
      }
      expect(observedOverrides[0]).toMatchObject({
        runtime: 'claude-sdk',
        reasoningLevel: 'low',
      });
      expect(observedOverrides[1]).toMatchObject({
        runtime: 'claude-sdk',
        reasoningLevel: 'high',
      });
    });
  });

  describe('handleGet', () => {
    it('returns the evaluation + attached runs + aggregate stats', async () => {
      const { handleCreate, handleGet } = makeHandlers();
      runAgentSpy.mockImplementation(async () => ({ runId: 'unused', status: 'completed' }));

      const created = await handleCreate(makeRequest({
        body: {
          taskId: 'full-intelligence',
          matrix: { runtimes: ['claude-sdk', 'openai-agents'], dryRun: true },
        },
      }));
      const { evaluationId } = created.body as { evaluationId: string };

      // Synthesize child runs directly so we can assert aggregation without
      // relying on the runAgent stub to write them.
      insertRun({
        id: 'cell-1', agent_id: 'myco-agent', evaluationId, status: 'completed',
        tokens_used: 100, cost_usd: 0.01,
      });
      insertRun({
        id: 'cell-2', agent_id: 'myco-agent', evaluationId, status: 'failed',
        tokens_used: 50, cost_usd: 0.005,
      });

      const res = await handleGet(makeRequest({ params: { id: evaluationId } }));
      const body = res.body as {
        evaluation: { id: string; taskId: string };
        runs: unknown[];
        aggregate: { total: number; completed: number; failed: number; totalTokens: number; totalCostUsd: number };
      };
      expect(body.evaluation.id).toBe(evaluationId);
      expect(body.evaluation.taskId).toBe('full-intelligence');
      expect(body.runs).toHaveLength(2);
      expect(body.aggregate.total).toBe(2);
      expect(body.aggregate.completed).toBe(1);
      expect(body.aggregate.failed).toBe(1);
      expect(body.aggregate.totalTokens).toBe(150);
      expect(body.aggregate.totalCostUsd).toBeCloseTo(0.015);
    });

    it('attaches per-run write_intents totals + duration_ms to each child', async () => {
      const { handleCreate, handleGet } = makeHandlers();
      runAgentSpy.mockImplementation(async () => ({ runId: 'unused', status: 'completed' }));

      const created = await handleCreate(makeRequest({
        body: {
          taskId: 'full-intelligence',
          matrix: { runtimes: ['claude-sdk'], dryRun: true },
        },
      }));
      const { evaluationId } = created.body as { evaluationId: string };

      // cell-A: two write intents (two different tools), with a duration.
      insertRun({
        id: 'cell-a', agent_id: 'myco-agent', evaluationId, status: 'completed',
        started_at: 1_000, completed_at: 1_042,
        tokens_used: 100, cost_usd: 0.01,
      });
      insertWriteIntent({
        runId: 'cell-a', toolName: 'vault_create_spore',
        toolInput: '{}', syntheticOutput: '{}',
      });
      insertWriteIntent({
        runId: 'cell-a', toolName: 'vault_create_spore',
        toolInput: '{}', syntheticOutput: '{}',
      });
      insertWriteIntent({
        runId: 'cell-a', toolName: 'vault_write_skill',
        toolInput: '{}', syntheticOutput: '{}',
      });

      // cell-B: no intents, never finished — duration_ms should be null.
      insertRun({
        id: 'cell-b', agent_id: 'myco-agent', evaluationId, status: 'failed',
        started_at: 2_000, completed_at: null,
      });

      const res = await handleGet(makeRequest({ params: { id: evaluationId } }));
      const body = res.body as {
        runs: Array<{
          id: string;
          duration_ms: number | null;
          write_intents: { total: number; by_tool: Record<string, number> };
        }>;
      };

      const a = body.runs.find((r) => r.id === 'cell-a');
      const b = body.runs.find((r) => r.id === 'cell-b');
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      expect(a!.duration_ms).toBe(42_000); // (1042 - 1000) * 1000
      expect(a!.write_intents.total).toBe(3);
      expect(a!.write_intents.by_tool['vault_create_spore']).toBe(2);
      expect(a!.write_intents.by_tool['vault_write_skill']).toBe(1);

      expect(b!.duration_ms).toBeNull();
      expect(b!.write_intents.total).toBe(0);
      expect(b!.write_intents.by_tool).toEqual({});
    });

    it('surfaces reasoning_level and execution_overrides on each child run', async () => {
      const { handleCreate, handleGet } = makeHandlers();
      runAgentSpy.mockImplementation(async () => ({ runId: 'unused', status: 'completed' }));

      const created = await handleCreate(makeRequest({
        body: {
          taskId: 'full-intelligence',
          matrix: {
            runtimes: ['claude-sdk'],
            phases: { extract: { reasoningLevel: 'low' } },
          },
        },
      }));
      const { evaluationId } = created.body as { evaluationId: string };

      insertRun({
        id: 'cell-r',
        agent_id: 'myco-agent',
        evaluationId,
        status: 'completed',
        reasoningLevel: 'high',
        executionOverrides: {
          runtime: 'claude-sdk',
          reasoningLevel: 'high',
          phases: { extract: { reasoningLevel: 'low' } },
        },
      });

      const res = await handleGet(makeRequest({ params: { id: evaluationId } }));
      const body = res.body as {
        runs: Array<{
          id: string;
          reasoning_level: string | null;
          execution_overrides: Record<string, unknown> | null;
        }>;
      };
      const row = body.runs.find((r) => r.id === 'cell-r');
      expect(row).toBeDefined();
      expect(row!.reasoning_level).toBe('high');
      expect(row!.execution_overrides).toEqual({
        runtime: 'claude-sdk',
        reasoningLevel: 'high',
        phases: { extract: { reasoningLevel: 'low' } },
      });
    });

    it('returns 404 for an unknown evaluation', async () => {
      const { handleGet } = makeHandlers();
      const res = await handleGet(makeRequest({ params: { id: 'nope' } }));
      expect(res.status).toBe(404);
    });
  });

  describe('handleList', () => {
    it('returns both evaluations with the expected fields', async () => {
      runAgentSpy.mockImplementation(async () => ({ runId: 'r', status: 'completed' }));
      const { handleCreate, handleList } = makeHandlers();

      // Two evaluations created back-to-back can share a created_at (seconds
      // resolution); the secondary `id DESC` tiebreaker is uuid-lex order,
      // which is non-deterministic. Assert the membership + shape rather
      // than absolute ordering.
      const a = (await handleCreate(makeRequest({ body: { taskId: 't1', matrix: {} } }))).body as { evaluationId: string };
      const b = (await handleCreate(makeRequest({ body: { taskId: 't2', matrix: {} } }))).body as { evaluationId: string };

      const res = await handleList(makeRequest({ query: {} }));
      const body = res.body as { evaluations: Array<{ id: string; taskId: string }> };
      const ids = body.evaluations.map((e) => e.id);
      expect(ids).toEqual(expect.arrayContaining([a.evaluationId, b.evaluationId]));
      expect(body.evaluations.find((e) => e.id === a.evaluationId)?.taskId).toBe('t1');
      expect(body.evaluations.find((e) => e.id === b.evaluationId)?.taskId).toBe('t2');
    });
  });
});
