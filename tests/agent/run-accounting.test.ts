import { describe, expect, it } from 'bun:test';
import { analyzeRuntimeTokenBudget, buildRunAccountingUpdate } from '@myco/agent/run-accounting.js';
import type { CostResolution } from '@myco/agent/cost/types.js';

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
      runtime: 'openai-agents',
      provider: {
        type: 'lmstudio',
        model: 'google/gemma-4-26b-a4b',
        contextLength: 32_768,
      },
      model: 'google/gemma-4-26b-a4b',
      checkpointState: {
        runtime: 'openai-agents',
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
