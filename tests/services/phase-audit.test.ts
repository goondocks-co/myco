/**
 * buildPhaseAudit + GET /api/agent/runs/:id/audit integration tests.
 *
 * Thinner replacement for the 439-line mock-heavy file pruned in #296.
 * Seeds runs/reports/turns/write-intents through real query helpers and
 * asserts the full audit shape produced by buildPhaseAudit and surfaced
 * by handleGetRunAudit. No module mocks — wires createAgentRunHandlers
 * with stub deps just to reach the handler that exists at main.ts:1402.
 *
 * Covers:
 *  - Two-phase run: reports/turns aggregation, checkpoint summary/timestamps
 *  - Dry-run write-intent attribution by phase_id
 *  - Synthetic single-phase fallback (extract-only style)
 *  - Unknown run id returns null
 *  - Handler 404 vs 200 shape
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { insertTurn } from '@myco/db/queries/turns.js';
import { insertWriteIntent } from '@myco/db/queries/write-intents.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { buildPhaseAudit } from '@myco/services/phase-audit.js';
import { createAgentRunHandlers } from '@myco/daemon/api/agent-runs.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import type { RouteRequest } from '@myco/daemon/router.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const AGENT_ID = 'myco-agent';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    pathname: '/',
    requestContext: TEST_REQUEST_CONTEXT,
    ...overrides,
  } as RouteRequest;
}

function makeHandlers() {
  const logger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  };
  return createAgentRunHandlers({
    vaultDir: '/tmp/fake-vault',
    embeddingManager: {} as never,
    logger: logger as never,
  });
}

function buildUsageDataJson(phases: Array<{
  name: string;
  tokensUsed?: number;
  costUsd?: number | null;
  costSource?: string | null;
}>): string {
  return JSON.stringify({
    run: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    phases: phases.map((p) => ({
      name: p.name,
      usage: null,
      tokensUsed: p.tokensUsed ?? 0,
      costUsd: p.costUsd ?? null,
      costSource: p.costSource ?? null,
    })),
  });
}

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

describe('buildPhaseAudit', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: AGENT_ID, name: AGENT_ID, created_at: epochNow() });
  });

  it('joins reports, turns, usage_data, and checkpoints for a non-dry-run', () => {
    const t1 = epochNow();
    const t2 = t1 + 10;

    insertRun({
      id: 'run-a',
      agent_id: AGENT_ID,
      task: 'vault-evolve',
      usage_data: buildUsageDataJson([
        { name: 'draft', tokensUsed: 1000, costUsd: 0.01, costSource: 'actual' },
        { name: 'review', tokensUsed: 500, costUsd: 0.005, costSource: 'actual' },
      ]),
      checkpoints: buildCheckpointsJson([
        { name: 'draft', status: 'completed', summary: 'Drafted', turnsUsed: 3, tokensUsed: 1000, costUsd: 0.01, costSource: 'actual', updatedAt: t1 },
        { name: 'review', status: 'completed', summary: 'Reviewed', turnsUsed: 2, tokensUsed: 500, costUsd: 0.005, costSource: 'actual', updatedAt: t2 },
      ]),
    });

    insertReport({ run_id: 'run-a', agent_id: AGENT_ID, action: 'wrote', summary: 'Wrote spore', created_at: t1 });
    insertReport({ run_id: 'run-a', agent_id: AGENT_ID, action: 'read', summary: 'Read digest', created_at: t2 });

    insertTurn({ run_id: 'run-a', agent_id: AGENT_ID, turn_number: 1, tool_name: 'vault_create_spore' });
    insertTurn({ run_id: 'run-a', agent_id: AGENT_ID, turn_number: 2, tool_name: 'vault_create_spore' });
    insertTurn({ run_id: 'run-a', agent_id: AGENT_ID, turn_number: 3, tool_name: 'vault_recall' });

    const audit = buildPhaseAudit('run-a', ALL_PROJECTS_SCOPE);
    expect(audit).not.toBeNull();
    expect(audit!.runId).toBe('run-a');
    expect(audit!.taskName).toBe('vault-evolve');
    expect(audit!.dryRun).toBe(false);
    expect(audit!.phases).toHaveLength(2);

    const [draft, review] = audit!.phases;
    expect(draft.phaseName).toBe('draft');
    expect(draft.status).toBe('completed');
    expect(draft.summary).toBe('Drafted');
    expect(draft.turnsUsed).toBe(3);
    expect(draft.tokensUsed).toBe(1000);
    expect(draft.costUsd).toBeCloseTo(0.01);
    expect(draft.costSource).toBe('actual');
    expect(draft.maxTurns).toBeNull();
    expect(draft.completedAt).toBe(t1);
    expect(draft.writeIntents).toBeNull();

    // Run-level aggregates on both phases (no per-phase turn attribution).
    expect(draft.toolCalls['vault_create_spore']).toBe(2);
    expect(draft.toolCalls['vault_recall']).toBe(1);
    expect(draft.toolErrors).toEqual({});
    expect(draft.reports).toHaveLength(2);

    expect(review.phaseName).toBe('review');
    expect(review.toolCalls).toEqual(draft.toolCalls);
    expect(review.reports).toHaveLength(2);
  });

  it('attributes write intents per phase when dry_run is true', () => {
    insertRun({
      id: 'run-dry',
      agent_id: AGENT_ID,
      task: 'vault-evolve',
      dryRun: true,
      usage_data: buildUsageDataJson([
        { name: 'draft' },
        { name: 'review' },
      ]),
      checkpoints: buildCheckpointsJson([
        { name: 'draft', status: 'completed', turnsUsed: 2 },
        { name: 'review', status: 'completed', turnsUsed: 1 },
      ]),
    });

    insertWriteIntent({ runId: 'run-dry', phaseId: 'draft', toolName: 'vault_create_spore', toolInput: '{}', syntheticOutput: '{}' });
    insertWriteIntent({ runId: 'run-dry', phaseId: 'draft', toolName: 'vault_create_spore', toolInput: '{}', syntheticOutput: '{}' });
    insertWriteIntent({ runId: 'run-dry', phaseId: 'draft', toolName: 'vault_write_skill', toolInput: '{}', syntheticOutput: '{}' });
    insertWriteIntent({ runId: 'run-dry', phaseId: 'review', toolName: 'vault_create_spore', toolInput: '{}', syntheticOutput: '{}' });
    insertWriteIntent({ runId: 'run-dry', phaseId: null, toolName: 'vault_create_spore', toolInput: '{}', syntheticOutput: '{}' });

    const audit = buildPhaseAudit('run-dry', ALL_PROJECTS_SCOPE);
    expect(audit!.dryRun).toBe(true);
    const [draft, review] = audit!.phases;

    expect(draft.writeIntents!.total).toBe(3);
    expect(draft.writeIntents!.byTool['vault_create_spore']).toBe(2);
    expect(draft.writeIntents!.byTool['vault_write_skill']).toBe(1);

    expect(review.writeIntents!.total).toBe(1);
    expect(review.writeIntents!.byTool['vault_create_spore']).toBe(1);
    expect(review.writeIntents!.byTool['vault_write_skill']).toBeUndefined();
  });

  it('returns null for an unknown run id', () => {
    expect(buildPhaseAudit('does-not-exist', ALL_PROJECTS_SCOPE)).toBeNull();
  });

  it('synthesizes a single "run" phase for non-phased tasks with turns', () => {
    const t1 = epochNow();
    const t2 = t1 + 7;
    insertRun({
      id: 'run-flat',
      agent_id: AGENT_ID,
      task: 'extract-only',
      status: 'completed',
      started_at: t1,
      completed_at: t2,
      tokens_used: 250,
      cost_usd: 0.002,
      cost_source: 'actual',
    });
    insertTurn({ run_id: 'run-flat', agent_id: AGENT_ID, turn_number: 1, tool_name: 'vault_recall' });
    insertTurn({ run_id: 'run-flat', agent_id: AGENT_ID, turn_number: 2, tool_name: 'vault_search' });

    const audit = buildPhaseAudit('run-flat', ALL_PROJECTS_SCOPE)!;
    expect(audit.phases).toHaveLength(1);
    const [only] = audit.phases;
    expect(only.phaseName).toBe('run');
    expect(only.status).toBe('completed');
    expect(only.turnsUsed).toBe(2);
    expect(only.tokensUsed).toBe(250);
    expect(only.startedAt).toBe(t1);
    expect(only.completedAt).toBe(t2);
    expect(only.toolCalls['vault_recall']).toBe(1);
    expect(only.toolCalls['vault_search']).toBe(1);
    expect(only.writeIntents).toBeNull();
  });

  it('returns empty phases array for an empty run with no turns', () => {
    insertRun({ id: 'run-empty', agent_id: AGENT_ID, task: null });
    const audit = buildPhaseAudit('run-empty', ALL_PROJECTS_SCOPE)!;
    expect(audit.phases).toHaveLength(0);
    expect(audit.taskName).toBeNull();
  });
});

describe('handleGetRunAudit', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: AGENT_ID, name: AGENT_ID, created_at: epochNow() });
  });

  it('returns 404 for an unknown run id', async () => {
    const { handleGetRunAudit } = makeHandlers();
    const res = await handleGetRunAudit(makeRequest({ params: { id: 'no-such-run' } }));
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('Run not found');
  });

  it('returns 200 with audit shape for an existing run', async () => {
    insertRun({
      id: 'run-handler',
      agent_id: AGENT_ID,
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
