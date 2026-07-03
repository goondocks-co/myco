import { describe, expect, test } from 'bun:test';
import { aggregateUsage } from './executor-state.js';
import { analyzeRuntimeTokenBudget } from './run-accounting.js';
import type { RuntimeUsage } from './types.js';

describe('aggregateUsage requestUsageEntries merging', () => {
  test('concatenates entries across phases rather than dropping or overwriting them', () => {
    const phase1: RuntimeUsage = {
      requests: 2,
      inputTokens: 300,
      outputTokens: 100,
      totalTokens: 400,
      requestUsageEntries: [
        { inputTokens: 200, outputTokens: 60, cachedTokens: 0, totalTokens: 260 },
        { inputTokens: 100, outputTokens: 40, cachedTokens: 0, totalTokens: 140 },
      ],
    };
    const phase2: RuntimeUsage = {
      requests: 1,
      inputTokens: 5000,
      outputTokens: 200,
      totalTokens: 5200,
      requestUsageEntries: [
        { inputTokens: 5000, outputTokens: 200, cachedTokens: 4500, totalTokens: 5200 },
      ],
    };

    const aggregate = aggregateUsage([phase1, phase2]);

    expect(aggregate.requestUsageEntries).toHaveLength(3);
    expect(aggregate.requestUsageEntries).toEqual([
      ...phase1.requestUsageEntries!,
      ...phase2.requestUsageEntries!,
    ]);
    // Run totals still sum normally — unaffected by entry merging.
    expect(aggregate.inputTokens).toBe(5300);
    expect(aggregate.outputTokens).toBe(300);
  });

  test('phases with no entries are skipped without producing empty/undefined slots', () => {
    const withEntries: RuntimeUsage = {
      requestUsageEntries: [{ inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15 }],
    };
    const withoutEntries: RuntimeUsage = { inputTokens: 50, outputTokens: 10 };

    const aggregate = aggregateUsage([withEntries, withoutEntries]);
    expect(aggregate.requestUsageEntries).toHaveLength(1);
  });

  test('no phase has entries: aggregate.requestUsageEntries stays undefined (falls back to run-total single-entry path)', () => {
    const aggregate = aggregateUsage([{ inputTokens: 10, outputTokens: 5, totalTokens: 15 }]);
    expect(aggregate.requestUsageEntries).toBeUndefined();
  });

  test('multi-phase peak-over-entries reflects the true cross-phase peak, not the summed run total', () => {
    // Phase A: 3 small requests. Phase B: 1 large request. The run total is
    // the sum of everything, but the peak must be phase B's single entry —
    // not the run-level cumulative total, which is what a phase-dropping
    // aggregation used to leave `analyzeRuntimeTokenBudget` to fall back to.
    const phaseA: RuntimeUsage = {
      inputTokens: 300,
      outputTokens: 90,
      totalTokens: 390,
      requestUsageEntries: [
        { inputTokens: 100, outputTokens: 30, cachedTokens: 0, totalTokens: 130 },
        { inputTokens: 100, outputTokens: 30, cachedTokens: 0, totalTokens: 130 },
        { inputTokens: 100, outputTokens: 30, cachedTokens: 0, totalTokens: 130 },
      ],
    };
    const phaseB: RuntimeUsage = {
      inputTokens: 8000,
      outputTokens: 500,
      totalTokens: 8500,
      requestUsageEntries: [
        { inputTokens: 8000, outputTokens: 500, cachedTokens: 0, totalTokens: 8500 },
      ],
    };

    const runUsage = aggregateUsage([phaseA, phaseB]);
    const budget = analyzeRuntimeTokenBudget(runUsage, { type: 'anthropic', contextLength: 200_000 });

    expect(budget.peakRequestTotalTokens).toBe(8500);
    expect(runUsage.totalTokens).toBe(390 + 8500);
    expect(budget.peakRequestTotalTokens).toBeLessThan(runUsage.totalTokens!);
  });
});
