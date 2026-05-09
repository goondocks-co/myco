/**
 * Tests for the phase-audit service and the GET /api/agent/runs/:id/audit
 * handler.
 *
 * Uses the shared in-memory SQLite test helpers — same pattern as
 * tests/daemon/api/agent-runs-dry-run.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { insertTurn } from '@myco/db/queries/turns.js';
import { insertWriteIntent } from '@myco/db/queries/write-intents.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { buildPhaseAudit } from '@myco/services/phase-audit.js';
import { createAgentRunHandlers } from '@myco/daemon/api/agent-runs';
import type { RouteRequest } from '@myco/daemon/router';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
// ---------------------------------------------------------------------------
// Mocks required by createAgentRunHandlers (not exercised in audit tests)
// ---------------------------------------------------------------------------

mock.module('@myco/agent/executor.js', () => ({
  runAgent: vi.fn(async () => ({ runId: 'stub', status: 'completed' as const })),
}));

mock.module('@myco/config/loader.js', () => ({
  loadMergedConfig: () => ({ agent: { tasks: {} } }),
}));

mock.module('@myco/agent/config-resolver.js', () => ({
  hasConfiguredProvider: () => true,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const epochNow = () => Math.floor(Date.now() / 1000);

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { params: {}, query: {}, body: undefined, pathname: '/', requestContext: TEST_REQUEST_CONTEXT, ...overrides } as RouteRequest;
}

function makeHandlers() {
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };
  return createAgentRunHandlers({
    vaultDir: '/tmp/fake-vault',
    embeddingManager: {} as never,
    logger: logger as never,
  });
}

/**
 * Build a JSON usage_data blob that matches the shape produced by
 * buildUsageData() in executor-state.ts.
 */
function buildUsageDataJson(phases: Array<{
  name: string;
  tokensUsed?: number;
  costUsd?: number | null;
  costSource?: string | null;
}>): string {
  return JSON.stringify({
    run: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    runCost: null,
    runBudget: null,
    phases: phases.map((p) => ({
      name: p.name,
      usage: null,
      tokensUsed: p.tokensUsed ?? 0,
      costUsd: p.costUsd ?? null,
      costSource: p.costSource ?? null,
      costData: null,
    })),
  });
}

/**
 * Build a JSON checkpoints blob matching RunCheckpointState.
 */
function buildCheckpointsJson(phases: Array<{
  name: string;
  status?: string;
  summary?: string;
  turnsUsed?: number;
  tokensUsed?: number;
  costUsd?: number | null;
  costSource?: string | null;
  updatedAt?: number;
}>): string {
  const phaseMap: Record<string, unknown> = {};
  for (const p of phases) {
    phaseMap[p.name] = {
      name: p.name,
      status: p.status ?? 'completed',
      summary: p.summary ?? null,
      turnsUsed: p.turnsUsed ?? 0,
      tokensUsed: p.tokensUsed ?? 0,
      costUsd: p.costUsd ?? null,
      costSource: p.costSource ?? null,
      updatedAt: p.updatedAt ?? epochNow(),
    };
  }
  return JSON.stringify({ runtime: 'claude-sdk', phases: phaseMap });
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('buildPhaseAudit', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: 'myco-agent', name: 'Test Agent', created_at: epochNow() });
  });

  // -------------------------------------------------------------------------
  // Core non-dry-run test
  // -------------------------------------------------------------------------

  it('joins reports, turns, usage_data, and checkpoints for a non-dry-run', () => {
    const t1 = epochNow();
    const t2 = t1 + 10;

    insertRun({
      id: 'run-a',
      agent_id: 'myco-agent',
      task: 'vault-evolve',
      usage_data: buildUsageDataJson([
        { name: 'draft', tokensUsed: 1000, costUsd: 0.01, costSource: 'actual' },
        { name: 'review', tokensUsed: 500, costUsd: 0.005, costSource: 'actual' },
      ]),
      checkpoints: buildCheckpointsJson([
        {
          name: 'draft',
          status: 'completed',
          summary: 'Drafted the content',
          turnsUsed: 3,
          tokensUsed: 1000,
          costUsd: 0.01,
          costSource: 'actual',
          updatedAt: t1,
        },
        {
          name: 'review',
          status: 'completed',
          summary: 'Reviewed the draft',
          turnsUsed: 2,
          tokensUsed: 500,
          costUsd: 0.005,
          costSource: 'actual',
          updatedAt: t2,
        },
      ]),
    });

    // Two reports (no phase column — all attached to every phase)
    insertReport({ run_id: 'run-a', agent_id: 'myco-agent', action: 'wrote', summary: 'Wrote spore', created_at: t1 });
    insertReport({ run_id: 'run-a', agent_id: 'myco-agent', action: 'read', summary: 'Read digest', created_at: t2 });

    // Three turns: two tools in draft, one in review (no phase column — run-level totals)
    insertTurn({ run_id: 'run-a', agent_id: 'myco-agent', turn_number: 1, tool_name: 'vault_create_spore' });
    insertTurn({ run_id: 'run-a', agent_id: 'myco-agent', turn_number: 2, tool_name: 'vault_create_spore' });
    insertTurn({ run_id: 'run-a', agent_id: 'myco-agent', turn_number: 3, tool_name: 'vault_recall' });

    const audit = buildPhaseAudit('run-a', ALL_PROJECTS_SCOPE);

    expect(audit).not.toBeNull();
    expect(audit!.runId).toBe('run-a');
    expect(audit!.taskName).toBe('vault-evolve');
    expect(audit!.dryRun).toBe(false);
    expect(audit!.phases).toHaveLength(2);

    const [draft, review] = audit!.phases;

    // Draft phase checks
    expect(draft.phaseName).toBe('draft');
    expect(draft.status).toBe('completed');
    expect(draft.summary).toBe('Drafted the content');
    expect(draft.turnsUsed).toBe(3);
    expect(draft.tokensUsed).toBe(1000);
    expect(draft.costUsd).toBeCloseTo(0.01);
    expect(draft.costSource).toBe('actual');
    expect(draft.maxTurns).toBeNull();
    expect(draft.startedAt).toBeNull();
    expect(draft.completedAt).toBe(t1);
    expect(draft.skipReason).toBeNull();
    expect(draft.writeIntents).toBeNull();

    // Run-level tool calls on the draft phase
    expect(draft.toolCalls['vault_create_spore']).toBe(2);
    expect(draft.toolCalls['vault_recall']).toBe(1);
    expect(draft.toolErrors).toEqual({});

    // All reports attached to every phase
    expect(draft.reports).toHaveLength(2);
    expect(draft.reports[0].action).toBe('wrote');
    expect(draft.reports[1].action).toBe('read');

    // Review phase: check second phase's tool call counts match (run-level)
    expect(review.phaseName).toBe('review');
    expect(review.toolCalls['vault_create_spore']).toBe(2);
    expect(review.toolCalls['vault_recall']).toBe(1);
    expect(review.writeIntents).toBeNull();
    expect(review.reports).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Dry-run write-intents test
  // -------------------------------------------------------------------------

  it('populates writeIntents per phase when dry_run is true', () => {
    insertRun({
      id: 'run-dry',
      agent_id: 'myco-agent',
      task: 'vault-evolve',
      dryRun: true,
      usage_data: buildUsageDataJson([
        { name: 'draft', tokensUsed: 800 },
        { name: 'review', tokensUsed: 200 },
      ]),
      checkpoints: buildCheckpointsJson([
        { name: 'draft', status: 'completed', turnsUsed: 2 },
        { name: 'review', status: 'completed', turnsUsed: 1 },
      ]),
    });

    // Write intents tagged to 'draft' phase
    insertWriteIntent({
      runId: 'run-dry',
      phaseId: 'draft',
      toolName: 'vault_create_spore',
      toolInput: JSON.stringify({ content: 'hello' }),
      syntheticOutput: JSON.stringify({ id: 'stub-1' }),
      stubId: 'stub-1',
    });
    insertWriteIntent({
      runId: 'run-dry',
      phaseId: 'draft',
      toolName: 'vault_create_spore',
      toolInput: JSON.stringify({ content: 'world' }),
      syntheticOutput: JSON.stringify({ id: 'stub-2' }),
      stubId: 'stub-2',
    });
    insertWriteIntent({
      runId: 'run-dry',
      phaseId: 'draft',
      toolName: 'vault_write_skill',
      toolInput: JSON.stringify({ name: 'foo' }),
      syntheticOutput: JSON.stringify({ path: '/fake' }),
    });

    // Write intent tagged to 'review' phase
    insertWriteIntent({
      runId: 'run-dry',
      phaseId: 'review',
      toolName: 'vault_create_spore',
      toolInput: JSON.stringify({ content: 'review note' }),
      syntheticOutput: JSON.stringify({ id: 'stub-3' }),
      stubId: 'stub-3',
    });

    // Unattributed intent (null phase_id)
    insertWriteIntent({
      runId: 'run-dry',
      phaseId: null,
      toolName: 'vault_create_spore',
      toolInput: JSON.stringify({ content: 'orphan' }),
      syntheticOutput: JSON.stringify({ id: 'stub-4' }),
    });

    const audit = buildPhaseAudit('run-dry', ALL_PROJECTS_SCOPE);

    expect(audit).not.toBeNull();
    expect(audit!.dryRun).toBe(true);
    expect(audit!.phases).toHaveLength(2);

    const [draft, review] = audit!.phases;

    // Draft phase write intents
    expect(draft.writeIntents).not.toBeNull();
    expect(draft.writeIntents!.total).toBe(3);
    expect(draft.writeIntents!.byTool['vault_create_spore']).toBe(2);
    expect(draft.writeIntents!.byTool['vault_write_skill']).toBe(1);

    // Review phase write intents
    expect(review.writeIntents).not.toBeNull();
    expect(review.writeIntents!.total).toBe(1);
    expect(review.writeIntents!.byTool['vault_create_spore']).toBe(1);
    expect(review.writeIntents!.byTool['vault_write_skill']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Non-existent run
  // -------------------------------------------------------------------------

  it('returns null for an unknown run id', () => {
    const audit = buildPhaseAudit('does-not-exist', ALL_PROJECTS_SCOPE);
    expect(audit).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Empty run (no phases in usage_data or checkpoints)
  // -------------------------------------------------------------------------

  it('returns empty phases array when run has no phase data and no turns', () => {
    insertRun({ id: 'run-empty', agent_id: 'myco-agent', task: null });
    const audit = buildPhaseAudit('run-empty', ALL_PROJECTS_SCOPE);
    expect(audit).not.toBeNull();
    expect(audit!.phases).toHaveLength(0);
    expect(audit!.taskName).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Synthetic single-phase fallback (non-phased task with turns)
  // -------------------------------------------------------------------------

  it('synthesizes one "run" phase for non-phased runs with turns', () => {
    const t1 = epochNow();
    const t2 = t1 + 7;

    // extract-only style: no phases in usage_data or checkpoints, but the
    // run produced tool calls and eventually completed.
    insertRun({
      id: 'run-flat',
      agent_id: 'myco-agent',
      task: 'extract-only',
      status: 'completed',
      started_at: t1,
      completed_at: t2,
      tokens_used: 250,
      cost_usd: 0.002,
      cost_source: 'actual',
    });

    insertTurn({ run_id: 'run-flat', agent_id: 'myco-agent', turn_number: 1, tool_name: 'vault_recall' });
    insertTurn({ run_id: 'run-flat', agent_id: 'myco-agent', turn_number: 2, tool_name: 'vault_recall' });
    insertTurn({ run_id: 'run-flat', agent_id: 'myco-agent', turn_number: 3, tool_name: 'vault_search' });

    const audit = buildPhaseAudit('run-flat', ALL_PROJECTS_SCOPE);
    expect(audit).not.toBeNull();
    expect(audit!.phases).toHaveLength(1);

    const [only] = audit!.phases;
    expect(only.phaseName).toBe('run');
    expect(only.status).toBe('completed');
    expect(only.turnsUsed).toBe(3);
    expect(only.maxTurns).toBeNull();
    expect(only.tokensUsed).toBe(250);
    expect(only.costUsd).toBeCloseTo(0.002);
    expect(only.costSource).toBe('actual');
    expect(only.durationMs).toBe((t2 - t1) * 1000);
    expect(only.startedAt).toBe(t1);
    expect(only.completedAt).toBe(t2);
    expect(only.toolCalls['vault_recall']).toBe(2);
    expect(only.toolCalls['vault_search']).toBe(1);
    expect(only.writeIntents).toBeNull(); // not a dry run
  });

  it('synthetic phase includes write-intent totals for dry-run non-phased runs', () => {
    insertRun({
      id: 'run-dry-flat',
      agent_id: 'myco-agent',
      task: 'extract-only',
      dryRun: true,
      status: 'completed',
    });
    insertTurn({ run_id: 'run-dry-flat', agent_id: 'myco-agent', turn_number: 1, tool_name: 'vault_create_spore' });
    insertWriteIntent({
      runId: 'run-dry-flat',
      phaseId: null,
      toolName: 'vault_create_spore',
      toolInput: '{}',
      syntheticOutput: '{}',
    });
    insertWriteIntent({
      runId: 'run-dry-flat',
      phaseId: null,
      toolName: 'vault_write_skill',
      toolInput: '{}',
      syntheticOutput: '{}',
    });

    const audit = buildPhaseAudit('run-dry-flat', ALL_PROJECTS_SCOPE);
    expect(audit!.phases).toHaveLength(1);
    const [only] = audit!.phases;
    expect(only.writeIntents).not.toBeNull();
    expect(only.writeIntents!.total).toBe(2);
    expect(only.writeIntents!.byTool['vault_create_spore']).toBe(1);
    expect(only.writeIntents!.byTool['vault_write_skill']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('handleGetRunAudit', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: 'myco-agent', name: 'Test Agent', created_at: epochNow() });
  });

  it('returns 404 for an unknown run id', async () => {
    const { handleGetRunAudit } = makeHandlers();
    const res = await handleGetRunAudit(makeRequest({ params: { id: 'no-such-run' } }));
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('Run not found');
  });

  it('returns 200 with audit for an existing run', async () => {
    insertRun({
      id: 'run-handler',
      agent_id: 'myco-agent',
      task: 'vault-evolve',
      usage_data: buildUsageDataJson([{ name: 'draft', tokensUsed: 100 }]),
      checkpoints: buildCheckpointsJson([{ name: 'draft', status: 'completed', turnsUsed: 1 }]),
    });

    const { handleGetRunAudit } = makeHandlers();
    const res = await handleGetRunAudit(makeRequest({ params: { id: 'run-handler' } }));

    expect(res.status).toBeUndefined(); // default 200
    const body = res.body as { audit: { runId: string; phases: unknown[] } };
    expect(body.audit.runId).toBe('run-handler');
    expect(body.audit.phases).toHaveLength(1);
  });
});
