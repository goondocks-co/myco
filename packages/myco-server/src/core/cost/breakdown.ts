import type { CostBreakdown, RunUsage } from './types.js';

/** The counts a harness reported, with the uncached share of input derived; an absent count is zero. */
export function buildTokenBreakdown(usage: RunUsage): CostBreakdown {
  const inputTokens = usage.inputTokens ?? 0;
  const cachedInputTokens = usage.cachedTokens ?? 0;
  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    requestCount: usage.requests ?? 0,
  };
}
