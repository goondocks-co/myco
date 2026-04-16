import type { CostBreakdown } from './types.js';
import type { RuntimeUsage } from '@myco/agent/types.js';

export function buildTokenBreakdown(usage: RuntimeUsage): CostBreakdown {
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
