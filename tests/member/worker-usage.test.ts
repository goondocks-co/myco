import { describe, expect, it } from 'bun:test';
import { claudeUsage } from '@myco/runner/drivers/usage.js';
import { WorkerUsageSchema } from '@goondocks/myco-shared/worker-usage';

describe('native harness accounting', () => {
  it('uses all model totals instead of main-loop usage, including both cache categories', () => {
    expect(claudeUsage({
      total_cost_usd: 0.5,
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: {
        first: { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 20, cacheCreationInputTokens: 5 },
        second: { inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 7, cacheCreationInputTokens: 0 },
      },
    })).toEqual({ inputTokens: 46, outputTokens: 9, cachedTokens: 27, cacheCreationTokens: 5, costUsd: null, estimatedCostUsd: 0.5 });
  });

  it('keeps missing model components unknown and does not replace them with main-loop counts', () => {
    expect(claudeUsage({ usage: { input_tokens: 90 }, modelUsage: { first: { outputTokens: 2 } } }))
      .toMatchObject({ inputTokens: null, outputTokens: 2, cachedTokens: null, costUsd: null, estimatedCostUsd: null });
    expect(claudeUsage({})).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null, estimatedCostUsd: null });
  });

  it('refuses non-finite accounting and preserves known zero', () => {
    for (const value of [NaN, Infinity, -Infinity, -1]) {
      expect(WorkerUsageSchema.safeParse({ inputTokens: 1, outputTokens: 1, costUsd: value }).success).toBe(false);
    }
    expect(WorkerUsageSchema.parse({ inputTokens: 0, outputTokens: 0, costUsd: null, estimatedCostUsd: 0 }))
      .toMatchObject({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
  });
});
