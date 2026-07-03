import { describe, expect, it } from 'bun:test';
import { analyzeRuntimeTokenBudget, buildRunAccountingUpdate, runDurationMs, summarizePhaseCosts } from '@myco/agent/run-accounting.js';
import type { CostResolution } from '@myco/agent/cost/types.js';
import type { PhaseResult } from '@myco/agent/types.js';

describe('runDurationMs', () => {
  it('measures from started_at when the run was never resumed', () => {
    const ms = runDurationMs({ started_at: 1000, completed_at: 1010, resumed_at: null });
    expect(ms).toBe(10_000);
  });

  it('measures from resumed_at, not the original started_at, once the run has been resumed', () => {
    // started_at is preserved as the run's ORIGINAL dispatch time across
    // resumes (executor.ts) — duration must reflect the CURRENT attempt's
    // wall-clock span, not the time since the very first dispatch.
    const ms = runDurationMs({ started_at: 1000, completed_at: 1010, resumed_at: 1008 });
    expect(ms).toBe(2_000);
  });

  it('tolerates a missing resumed_at field (RunRow shape without the optional key)', () => {
    const ms = runDurationMs({ started_at: 1000, completed_at: 1010 });
    expect(ms).toBe(10_000);
  });

  it('returns null when completed_at is missing', () => {
    expect(runDurationMs({ started_at: 1000, completed_at: null, resumed_at: null })).toBeNull();
  });

  it('returns null when started_at is missing, even with a resumed_at present', () => {
    expect(runDurationMs({ started_at: null, completed_at: 1010, resumed_at: null })).toBeNull();
  });
});

describe('analyzeRuntimeTokenBudget', () => {
  it('computes utilization and headroom when context length is known', () => {
    const budget = analyzeRuntimeTokenBudget(
      {
        requests: 2,
        inputTokens: 28_000,
        outputTokens: 1_100,
        totalTokens: 29_100,
        requestUsageEntries: [
          { inputTokens: 7_000, outputTokens: 200, totalTokens: 7_200 },
          { inputTokens: 20_000, outputTokens: 900, totalTokens: 20_900 },
        ],
      },
      {
        type: 'lmstudio',
        model: 'google/gemma-4-26b-a4b',
        contextLength: 32_768,
      },
    );

    expect(budget.contextWindowTokens).toBe(32_768);
    expect(budget.peakRequestInputTokens).toBe(20_000);
    expect(budget.peakRequestOutputTokens).toBe(900);
    expect(budget.peakRequestTotalTokens).toBe(20_900);
    expect(budget.utilizationPercent).toBe(64);
    expect(budget.headroomTokens).toBe(11_868);
    expect(budget.status).toBe('ok');
  });

  it('marks usage as warning when nearing the context limit', () => {
    const budget = analyzeRuntimeTokenBudget(
      {
        requestUsageEntries: [
          { inputTokens: 24_000, outputTokens: 4_000, totalTokens: 28_000 },
        ],
      },
      {
        type: 'ollama',
        model: 'gemma4:26b',
        contextLength: 32_768,
      },
    );

    expect(budget.utilizationPercent).toBe(85);
    expect(budget.status).toBe('warning');
    expect(budget.message).toContain('large share');
  });

  it('uses an inferred provider default for frontier cloud models', () => {
    const budget = analyzeRuntimeTokenBudget(
      {
        requestUsageEntries: [
          { inputTokens: 10_000, outputTokens: 500, totalTokens: 10_500 },
        ],
      },
      {
        type: 'openai',
        model: 'gpt-5.4-mini',
      },
    );

    expect(budget.contextWindowTokens).toBe(200_000);
    expect(budget.contextWindowSource).toBe('provider-default');
    expect(budget.peakRequestTotalTokens).toBe(10_500);
    expect(budget.status).toBe('ok');
    expect(budget.message).toContain('inferred provider default');
  });

  it('returns unknown when no provider context is available at all', () => {
    const budget = analyzeRuntimeTokenBudget(
      {
        requestUsageEntries: [
          { inputTokens: 10_000, outputTokens: 500, totalTokens: 10_500 },
        ],
      },
      undefined,
    );

    expect(budget.contextWindowTokens).toBeNull();
    expect(budget.contextWindowSource).toBeUndefined();
    expect(budget.peakRequestTotalTokens).toBe(10_500);
    expect(budget.status).toBe('unknown');
  });

  it('uses the local 32k default for lmstudio when no override is set', () => {
    const budget = analyzeRuntimeTokenBudget(
      {
        requestUsageEntries: [
          { inputTokens: 20_107, outputTokens: 1_288, totalTokens: 21_395 },
        ],
      },
      {
        type: 'lmstudio',
        model: 'google/gemma-4-26b-a4b',
      },
    );

    expect(budget.contextWindowTokens).toBe(32_768);
    expect(budget.contextWindowSource).toBe('provider-default');
    expect(budget.utilizationPercent).toBe(65);
    expect(budget.status).toBe('ok');
  });

  it('prefers provider metadata over inferred defaults', () => {
    const budget = analyzeRuntimeTokenBudget(
      {
        requestUsageEntries: [
          { inputTokens: 50_000, outputTokens: 1_000, totalTokens: 51_000 },
        ],
        providerData: {
          contextWindowTokens: 1_000_000,
        },
      },
      {
        type: 'openai',
        model: 'gpt-5.4',
      },
    );

    expect(budget.contextWindowTokens).toBe(1_000_000);
    expect(budget.contextWindowSource).toBe('provider-metadata');
    expect(budget.utilizationPercent).toBe(5);
  });

  it('falls back to aggregate usage when per-request entries are unavailable', () => {
    const budget = analyzeRuntimeTokenBudget(
      {
        requests: 1,
        inputTokens: 180_000,
        outputTokens: 12_000,
        totalTokens: 192_000,
      },
      {
        type: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
    );

    expect(budget.peakRequestInputTokens).toBe(180_000);
    expect(budget.peakRequestOutputTokens).toBe(12_000);
    expect(budget.peakRequestTotalTokens).toBe(192_000);
    expect(budget.contextWindowTokens).toBe(200_000);
    expect(budget.utilizationPercent).toBe(96);
    expect(budget.status).toBe('post_run_pressure');
  });
});

describe('buildRunAccountingUpdate', () => {
  it('embeds token budget diagnostics into usage_data', () => {
    const costData: CostResolution = {
      source: 'unavailable',
      costUsd: null,
      actualCostUsd: null,
      estimatedCostUsd: null,
      pricingVersion: null,
      breakdown: {
        inputTokens: 28_000,
        cachedInputTokens: 0,
        uncachedInputTokens: 28_000,
        outputTokens: 1_100,
        reasoningTokens: 0,
        requestCount: 2,
      },
    };

    const update = buildRunAccountingUpdate({
      harness: 'openai-agents',
      provider: {
        type: 'lmstudio',
        model: 'google/gemma-4-26b-a4b',
        contextLength: 32_768,
      },
      model: 'google/gemma-4-26b-a4b',
      checkpointState: {
        harness: 'openai-agents',
        provider: 'lmstudio',
        phases: {},
      },
      usage: {
        requests: 2,
        inputTokens: 28_000,
        outputTokens: 1_100,
        totalTokens: 29_100,
        requestUsageEntries: [
          { inputTokens: 7_000, outputTokens: 200, totalTokens: 7_200 },
          { inputTokens: 20_000, outputTokens: 900, totalTokens: 20_900 },
        ],
      },
      costData,
    });

    const usageData = JSON.parse(update.usage_data ?? '{}') as {
      runBudget?: { contextWindowTokens: number; peakRequestTotalTokens: number; utilizationPercent: number };
    };

    expect(usageData.runBudget).toMatchObject({
      contextWindowTokens: 32_768,
      peakRequestTotalTokens: 20_900,
      utilizationPercent: 64,
    });
  });
});

describe('summarizePhaseCosts', () => {
  const actualCost = (usd: number): CostResolution => ({
    source: 'actual',
    costUsd: usd,
    actualCostUsd: usd,
    estimatedCostUsd: null,
    pricingVersion: null,
    breakdown: {
      inputTokens: 100,
      cachedInputTokens: 0,
      uncachedInputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
      requestCount: 1,
    },
  });

  const completedPhase = (name: string, usd: number): PhaseResult => ({
    name,
    status: 'completed',
    turnsUsed: 3,
    tokensUsed: 150,
    costUsd: usd,
    costSource: 'actual',
    costData: actualCost(usd),
    summary: `${name} done`,
  });

  const skippedPhase = (name: string): PhaseResult => ({
    name,
    status: 'skipped',
    turnsUsed: 0,
    tokensUsed: 0,
    costUsd: 0,
    summary: `${name} skipped`,
  });

  it('reports actual provenance when skipped phases carry no cost data', () => {
    // Regression: gated/skipped phases (non-selected digest tiers,
    // preCondition short-circuits) used to drag the whole run to
    // source="estimated" / actual_cost_usd=null because the provenance
    // check ran over every phase rather than only the costed ones.
    const result = summarizePhaseCosts([
      completedPhase('extract', 0.3),
      completedPhase('consolidate-write', 0.05),
      skippedPhase('digest-10000'),
      skippedPhase('digest-1500'),
    ]);

    expect(result.source).toBe('actual');
    expect(result.actualCostUsd).toBeCloseTo(0.35, 6);
    expect(result.estimatedCostUsd).toBeNull();
    expect(result.costUsd).toBeCloseTo(0.35, 6);
  });

  it('falls back to estimated when a costed phase is itself estimated', () => {
    const estimated: CostResolution = {
      source: 'estimated',
      costUsd: 0.1,
      actualCostUsd: null,
      estimatedCostUsd: 0.1,
      pricingVersion: null,
      breakdown: {
        inputTokens: 100,
        cachedInputTokens: 0,
        uncachedInputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        requestCount: 1,
      },
    };
    const estimatedPhase: PhaseResult = {
      name: 'extract',
      status: 'completed',
      turnsUsed: 3,
      tokensUsed: 150,
      costUsd: 0.1,
      costSource: 'estimated',
      costData: estimated,
      summary: 'extract done',
    };

    const result = summarizePhaseCosts([
      completedPhase('consolidate-write', 0.05),
      estimatedPhase,
      skippedPhase('digest-1500'),
    ]);

    expect(result.source).toBe('estimated');
    expect(result.actualCostUsd).toBeNull();
  });
});
