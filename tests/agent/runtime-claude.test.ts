/**
 * Tests for ClaudeSdkRuntime.execute() covering:
 *   - session ref forwarding (sessionId is passed through to the SDK)
 *   - abortController forwarded when present
 *   - scoped tool server created with toolNames + dryRun
 *   - usage aggregation from the result message
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: claude-agent-sdk.query — capture args, control the stream
// ---------------------------------------------------------------------------

const queryCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push(args);
    return {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: 'assistant' as const,
          message: { role: 'assistant', content: 'thinking' },
          uuid: 'a-1',
          session_id: 'test-session',
        };
        yield {
          type: 'result' as const,
          subtype: 'success' as const,
          total_cost_usd: 0.0123,
          usage: { input_tokens: 42, output_tokens: 7 },
          num_turns: 1,
          duration_ms: 100,
          duration_api_ms: 80,
          is_error: false,
          result: 'final response',
          stop_reason: 'end_turn',
          modelUsage: {},
          permission_denials: [],
          uuid: 'r-1',
          session_id: 'test-session',
        };
      },
    };
  },
  createSdkMcpServer: (opts: Record<string, unknown>) => ({
    type: 'sdk' as const,
    instance: {},
    ...opts,
  }),
  tool: (_name: string, _desc: string, _schema: unknown, handler: unknown) => ({
    name: _name,
    handler,
  }),
}));

// ---------------------------------------------------------------------------
// Mock: tool server constructors — capture options (dryRun, toolNames, ...)
// ---------------------------------------------------------------------------

const scopedServerCalls: Array<{ agentId: string; runId: string; toolNames: string[]; options: Record<string, unknown> }> = [];
const fullServerCalls: Array<{ agentId: string; runId: string; options: Record<string, unknown> }> = [];

vi.mock('@myco/agent/tools.js', () => ({
  createVaultToolServer: (agentId: string, runId: string, options: Record<string, unknown> = {}) => {
    fullServerCalls.push({ agentId, runId, options });
    return { type: 'sdk' as const, name: 'myco-vault', instance: {} };
  },
  createScopedVaultToolServer: (agentId: string, runId: string, toolNames: string[], options: Record<string, unknown> = {}) => {
    scopedServerCalls.push({ agentId, runId, toolNames, options });
    return { type: 'sdk' as const, name: 'myco-vault', instance: {} };
  },
}));

vi.mock('@myco/agent/provider.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@myco/agent/provider.js')>();
  return {
    ...original,
    buildPhaseEnv: () => ({}),
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function loadRuntime() {
  const mod = await import('@myco/agent/runtime/claude.js');
  return mod.ClaudeSdkRuntime;
}

function makeInput(overrides: Partial<import('@myco/agent/runtime/types.js').RuntimeExecuteInput> = {}) {
  return {
    prompt: 'Do the thing.',
    model: 'claude-sonnet-4-6',
    maxTurns: 5,
    systemPrompt: 'You are a test agent.',
    toolSurface: {
      agentId: 'test-agent',
      runId: 'test-run',
      toolNames: ['vault_report'],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeSdkRuntime.execute', () => {
  beforeEach(() => {
    queryCalls.length = 0;
    scopedServerCalls.length = 0;
    fullServerCalls.length = 0;
  });

  it('forwards sessionRef as sessionId to the SDK when provided', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    const result = await runtime.execute(makeInput({ sessionRef: 'sess-abc' }));

    expect(queryCalls[0].options.sessionId).toBe('sess-abc');
    expect(result.sessionRef).toBe('sess-abc');
  });

  it('omits sessionId when no sessionRef is provided', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput());

    expect('sessionId' in queryCalls[0].options).toBe(false);
  });

  it('forwards abortController to the SDK when present', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    const controller = new AbortController();
    await runtime.execute(makeInput({ abortController: controller }));

    expect(queryCalls[0].options.abortController).toBe(controller);
  });

  it('omits abortController when not supplied', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput());

    expect('abortController' in queryCalls[0].options).toBe(false);
  });

  it('constructs a scoped tool server when toolSurface.toolNames is provided', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      toolSurface: {
        agentId: 'a1',
        runId: 'r1',
        toolNames: ['vault_report'],
        dryRun: true,
      },
    }));

    expect(scopedServerCalls).toHaveLength(1);
    expect(scopedServerCalls[0].toolNames).toEqual(['vault_report']);
    expect(scopedServerCalls[0].options.dryRun).toBe(true);
    expect(fullServerCalls).toHaveLength(0);
  });

  it('skips the MCP server entirely when toolNames is an empty list', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a1', runId: 'r1', toolNames: [] },
    }));

    expect(queryCalls[0].options.mcpServers).toBeUndefined();
    expect(scopedServerCalls).toHaveLength(0);
    expect(fullServerCalls).toHaveLength(0);
  });

  it('aggregates usage from the final result message', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    const result = await runtime.execute(makeInput());
    expect(result.finalText).toBe('final response');
    expect(result.turnsUsed).toBe(1);
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.outputTokens).toBe(7);
    expect(result.usage.totalTokens).toBe(49);
    expect(result.usage.costUsd).toBeCloseTo(0.0123);
    expect(result.usage.requestUsageEntries).toHaveLength(1);
  });
});
