import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { consumeClaudeMessageStream } from '@myco/agent/harness/claude.js';
import { analyzeRuntimeTokenBudget } from '@myco/agent/run-accounting.js';

/**
 * Builds a synthetic `assistant` SDK message carrying a per-request
 * `BetaUsage` snapshot on `message.usage` — the shape the real SDK emits
 * once per API turn (see `BetaMessage.usage` in
 * `@anthropic-ai/sdk/resources/beta/messages/messages.d.mts`).
 */
function assistantMessage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): SDKMessage {
  return {
    type: 'assistant',
    message: { usage },
    parent_tool_use_id: null,
    uuid: 'uuid-assistant',
    session_id: 'session-1',
  } as unknown as SDKMessage;
}

/** Builds a synthetic terminal `result` message with run-cumulative usage. */
function resultMessage(input: {
  numTurns: number;
  totalCostUsd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  resultText?: string;
}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1000,
    duration_api_ms: 900,
    is_error: false,
    num_turns: input.numTurns,
    result: input.resultText ?? 'done',
    stop_reason: null,
    total_cost_usd: input.totalCostUsd,
    usage: input.usage,
    modelUsage: {},
    permission_denials: [],
    uuid: 'uuid-result',
    session_id: 'session-1',
  } as unknown as SDKMessage;
}

async function* streamOf(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  for (const message of messages) {
    yield message;
  }
}

describe('consumeClaudeMessageStream request usage entries', () => {
  test('multi-turn: emits one entry per assistant message with correct composition and totals match sum', async () => {
    const messages: SDKMessage[] = [
      assistantMessage({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
      assistantMessage({ input_tokens: 20, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 }),
      assistantMessage({ input_tokens: 30, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 950 }),
      resultMessage({
        numTurns: 3,
        totalCostUsd: 0.05,
        // Run-cumulative totals as the real SDK reports them on the terminal
        // result message: running sums across the whole conversation
        // (input 150 = 100+20+30, output 250 = 50+80+120, reads 1850 = 900+950).
        usage: { input_tokens: 150, output_tokens: 250, cache_creation_input_tokens: 0, cache_read_input_tokens: 1850 },
      }),
    ];

    const { usage } = await consumeClaudeMessageStream(streamOf(messages), { localProvider: false });

    expect(usage.requestUsageEntries).toHaveLength(3);

    const entries = usage.requestUsageEntries as Array<{
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      totalTokens: number;
    }>;

    // Entry 1: no cache activity.
    expect(entries[0]).toEqual({ inputTokens: 100, outputTokens: 50, cachedTokens: 0, totalTokens: 150 });
    // Entry 2: 900 cached-read tokens fold into inputTokens, cachedTokens = 900.
    expect(entries[1]).toEqual({ inputTokens: 920, outputTokens: 80, cachedTokens: 900, totalTokens: 1000 });
    // Entry 3: 950 cached-read tokens fold into inputTokens, cachedTokens = 950.
    expect(entries[2]).toEqual({ inputTokens: 980, outputTokens: 120, cachedTokens: 950, totalTokens: 1100 });

    // Run totals are sourced from the terminal `result` message only —
    // untouched by per-message entry collection.
    expect(usage.inputTokens).toBe(150 + 0 + 1850); // input_tokens + cache_creation + cache_read
    expect(usage.outputTokens).toBe(250);
    expect(usage.cachedTokens).toBe(1850);
    expect(usage.totalTokens).toBe(usage.inputTokens! + usage.outputTokens!);
    expect(usage.costUsd).toBe(0.05);
    expect(usage.requests).toBe(3);

    // Each per-message entry's own composition sums correctly internally.
    for (const entry of entries) {
      expect(entry.totalTokens).toBe(entry.inputTokens + entry.outputTokens);
    }

    // The peak single-request entry is far smaller than the run-cumulative
    // total — the whole point of the fix.
    const peakEntryTotal = Math.max(...entries.map((e) => e.totalTokens));
    expect(peakEntryTotal).toBeLessThan(usage.totalTokens!);
  });

  test('single-turn: behavior identical to today (one entry, matches run totals)', async () => {
    const messages: SDKMessage[] = [
      assistantMessage({ input_tokens: 200, output_tokens: 75, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
      resultMessage({
        numTurns: 1,
        totalCostUsd: 0.01,
        usage: { input_tokens: 200, output_tokens: 75, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
    ];

    const { usage } = await consumeClaudeMessageStream(streamOf(messages), { localProvider: false });

    expect(usage.requestUsageEntries).toHaveLength(1);
    expect(usage.requestUsageEntries![0]).toEqual({
      inputTokens: 200,
      outputTokens: 75,
      cachedTokens: 0,
      totalTokens: 275,
    });
    expect(usage.inputTokens).toBe(200);
    expect(usage.outputTokens).toBe(75);
    expect(usage.totalTokens).toBe(275);
    expect(usage.costUsd).toBe(0.01);
  });

  test('degrades to a single cumulative entry when no assistant message carries usage', async () => {
    // Defensive path: a stream that produces a result with turns/tokens but
    // whose assistant messages (for whatever SDK-shape reason) don't expose
    // `message.usage`. Must not crash, and must still produce a usable
    // (if cumulative) entry so budget analysis has something to peak over.
    const messages: SDKMessage[] = [
      { type: 'assistant', message: {}, parent_tool_use_id: null, uuid: 'u1', session_id: 's1' } as unknown as SDKMessage,
      resultMessage({
        numTurns: 1,
        totalCostUsd: 0.02,
        usage: { input_tokens: 300, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
    ];

    const { usage } = await consumeClaudeMessageStream(streamOf(messages), { localProvider: false });

    expect(usage.requestUsageEntries).toHaveLength(1);
    expect(usage.requestUsageEntries![0]).toEqual({
      inputTokens: 300,
      outputTokens: 60,
      cachedTokens: 0,
      totalTokens: 360,
    });
  });

  test('local provider: costUsd forced to 0 regardless of total_cost_usd', async () => {
    const messages: SDKMessage[] = [
      assistantMessage({ input_tokens: 50, output_tokens: 20 }),
      resultMessage({
        numTurns: 1,
        totalCostUsd: 0.99,
        usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
    ];

    const { usage } = await consumeClaudeMessageStream(streamOf(messages), { localProvider: true });
    expect(usage.costUsd).toBe(0);
  });
});

describe('analyzeRuntimeTokenBudget on real per-request entries', () => {
  const contextWindowProvider = { type: 'anthropic' as const, contextLength: 200_000 };

  test('healthy multi-turn run: cumulative total alone would exceed 100%, true peak does not', async () => {
    // 40 turns, each re-reading a ~15k-token cached prompt (cachedTokens
    // folds into inputTokens) plus a small per-turn delta and output. This
    // is the shape that previously triggered false-positive
    // agent.token-budget-pressure warnings: the OLD single synthetic entry
    // carried the run-cumulative total (40 * ~15.4k ≈ 616k tokens), which
    // alone is > 100% of a 200k context window even though no single
    // request ever approached the window.
    const messages: SDKMessage[] = [];
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    const perTurnCacheRead = 15_000;
    const perTurnFreshInput = 400;
    const perTurnOutput = 300;
    const turns = 40;
    for (let i = 0; i < turns; i++) {
      messages.push(assistantMessage({
        input_tokens: perTurnFreshInput,
        output_tokens: perTurnOutput,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: perTurnCacheRead,
      }));
      cumulativeInput += perTurnFreshInput + perTurnCacheRead;
      cumulativeOutput += perTurnOutput;
    }
    messages.push(resultMessage({
      numTurns: turns,
      totalCostUsd: 1.23,
      usage: {
        input_tokens: cumulativeInput,
        output_tokens: cumulativeOutput,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }));

    const { usage } = await consumeClaudeMessageStream(streamOf(messages), { localProvider: false });

    // Pin the exact cumulative total: this is what the OLD single-entry
    // implementation would have used as the (bogus) "peak request" size.
    expect(usage.totalTokens).toBe(cumulativeInput + cumulativeOutput);
    expect(usage.totalTokens).toBeGreaterThan(200_000); // old behavior: >100% util

    const oldStyleBudget = analyzeRuntimeTokenBudget(
      { ...usage, requestUsageEntries: [] }, // simulate pre-fix: no per-request entries
      contextWindowProvider,
    );
    expect(oldStyleBudget.utilizationPercent).toBeGreaterThan(100);
    expect(oldStyleBudget.status).toBe('post_run_pressure');

    const fixedBudget = analyzeRuntimeTokenBudget(usage, contextWindowProvider);
    // True per-request peak: perTurnFreshInput + perTurnCacheRead + perTurnOutput.
    const expectedPeak = perTurnFreshInput + perTurnCacheRead + perTurnOutput;
    expect(fixedBudget.peakRequestTotalTokens).toBe(expectedPeak);
    expect(fixedBudget.utilizationPercent).toBe(Math.round((expectedPeak / 200_000) * 100));
    expect(fixedBudget.utilizationPercent).toBeLessThan(100);
    expect(fixedBudget.status).toBe('ok');
  });

  test('peak-over-entries equals the max entry, not the sum, for a 3-message fixture', async () => {
    const messages: SDKMessage[] = [
      assistantMessage({ input_tokens: 1000, output_tokens: 200 }), // total 1200
      assistantMessage({ input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 4000 }), // total 4600
      assistantMessage({ input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 9000 }), // total 9350
      resultMessage({
        numTurns: 3,
        totalCostUsd: 0.1,
        usage: { input_tokens: 1800, output_tokens: 350, cache_creation_input_tokens: 0, cache_read_input_tokens: 13000 },
      }),
    ];

    const { usage } = await consumeClaudeMessageStream(streamOf(messages), { localProvider: false });
    const budget = analyzeRuntimeTokenBudget(usage, { type: 'anthropic', contextLength: 200_000 });

    expect(budget.peakRequestTotalTokens).toBe(9350);
    expect(budget.peakRequestTotalTokens).toBeLessThan(usage.totalTokens!);
  });
});
