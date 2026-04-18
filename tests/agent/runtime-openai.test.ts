/**
 * Tests for OpenAIAgentsRuntime.execute() covering the responsibilities not
 * exercised by openai-runtime.test.ts (which only tests pure helpers):
 *
 *   - PersistedSession round-trips input items on fresh + resumed runs.
 *   - mcpServer.close() runs on success AND on thrown paths (MCP lifecycle).
 *   - abortController is forwarded to Runner.run() when present.
 *   - Usage aggregation sums the rawResponses list and tolerates missing
 *     *TokensDetails arrays (local OpenAI-compatible providers).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @openai/agents — capture Runner.run args, control the result
// ---------------------------------------------------------------------------

interface MockRunOptions {
  maxTurns?: number;
  session?: { addItems: (items: unknown[]) => Promise<void>; getItems: () => Promise<unknown[]> };
  signal?: AbortSignal;
}

const runnerCalls: Array<{ agent: unknown; input: string; options: MockRunOptions }> = [];
let mockRunBehavior: 'success' | 'throw' = 'success';
let mockRunResult: {
  finalOutput: unknown;
  lastResponseId: string;
  rawResponses: Array<{
    usage: {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      inputTokensDetails?: Array<Record<string, number>>;
      outputTokensDetails?: Array<Record<string, number>>;
    };
  }>;
  appendItems: unknown[];
} = {
  finalOutput: 'done',
  lastResponseId: 'resp_123',
  rawResponses: [],
  appendItems: [],
};

vi.mock('@openai/agents', () => {
  class Agent {
    constructor(public readonly config: Record<string, unknown>) {}
  }
  class OpenAIProvider {
    constructor(public readonly config: Record<string, unknown>) {}
  }
  class Runner {
    constructor(public readonly config: Record<string, unknown>) {}
    async run(agent: unknown, input: string, options: MockRunOptions = {}) {
      runnerCalls.push({ agent, input, options });
      if (options.session && mockRunResult.appendItems.length > 0) {
        await options.session.addItems(mockRunResult.appendItems);
      }
      if (mockRunBehavior === 'throw') {
        throw new Error('Runner blew up');
      }
      return {
        finalOutput: mockRunResult.finalOutput,
        lastResponseId: mockRunResult.lastResponseId,
        rawResponses: mockRunResult.rawResponses,
      };
    }
  }
  return { Agent, Runner, OpenAIProvider };
});

// ---------------------------------------------------------------------------
// Mock openai (constructed as `new OpenAI(...)` in the runtime)
// ---------------------------------------------------------------------------

vi.mock('openai', () => {
  return {
    default: class OpenAI {
      constructor(public readonly config: Record<string, unknown>) {}
    },
  };
});

// ---------------------------------------------------------------------------
// Mock local-provider prep to avoid touching Ollama/LM Studio backends
// ---------------------------------------------------------------------------

vi.mock('@myco/agent/ollama-context.js', () => ({
  ensureOllamaContextVariant: async (model: string) => model,
}));

vi.mock('@myco/intelligence/lm-studio.js', () => ({
  LmStudioBackend: class {
    async ensureLoaded() {}
    getLoadedInstanceId() { return null; }
  },
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

async function loadRuntime() {
  const mod = await import('@myco/agent/runtime/openai.js');
  return mod.OpenAIAgentsRuntime;
}

function makeMcpServer() {
  return {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function makeContext(mcpServer: ReturnType<typeof makeMcpServer>) {
  return {
    createOpenAIMcpServer: vi.fn(() => mcpServer),
  } as unknown as import('@myco/agent/runtime/types.js').RuntimeFactoryContext;
}

function makeInput(overrides: Partial<import('@myco/agent/runtime/types.js').RuntimeExecuteInput> = {}) {
  return {
    prompt: 'Hello',
    model: 'gpt-5.4-mini',
    maxTurns: 3,
    provider: { type: 'openai' as const, model: 'gpt-5.4-mini' },
    toolSurface: { agentId: 'test-agent', runId: 'test-run' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAIAgentsRuntime.execute', () => {
  beforeEach(() => {
    runnerCalls.length = 0;
    mockRunBehavior = 'success';
    mockRunResult = {
      finalOutput: 'done',
      lastResponseId: 'resp_ok',
      rawResponses: [
        {
          usage: {
            requests: 1,
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            inputTokensDetails: [{ cached_tokens: 40 }],
            outputTokensDetails: [{ reasoning_tokens: 10 }],
          },
        },
        {
          usage: {
            requests: 1,
            inputTokens: 200,
            outputTokens: 60,
            totalTokens: 260,
            inputTokensDetails: [{ cached_tokens: 60 }],
            outputTokensDetails: [{ reasoning_tokens: 20 }],
          },
        },
      ],
      appendItems: [],
    };
  });

  it('persists session items into sessionData when the run appends new turns', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime(makeContext(mcp));

    mockRunResult.appendItems = [{ type: 'user', content: 'hi' }];

    const result = await runtime.execute(makeInput({ sessionRef: 'sess-1', sessionData: [] }));

    expect(result.sessionData).toEqual(mockRunResult.appendItems);
    expect(result.sessionRef).toBe('sess-1');
  });

  it('hydrates prior sessionData into the Session passed to the Runner', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime(makeContext(mcp));

    const priorItems = [{ type: 'user', content: 'previous turn' }];
    await runtime.execute(makeInput({ sessionRef: 'sess-resume', sessionData: priorItems }));

    expect(runnerCalls).toHaveLength(1);
    const session = runnerCalls[0].options.session!;
    expect(await session.getItems()).toEqual(priorItems);
  });

  it('calls mcpServer.close() on the successful path', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime(makeContext(mcp));

    await runtime.execute(makeInput());

    expect(mcp.close).toHaveBeenCalledTimes(1);
  });

  it('calls mcpServer.close() even when the Runner throws', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime(makeContext(mcp));
    mockRunBehavior = 'throw';

    await expect(runtime.execute(makeInput())).rejects.toThrow('Runner blew up');
    expect(mcp.close).toHaveBeenCalledTimes(1);
  });

  it('forwards the abortController.signal to Runner.run when provided', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime(makeContext(mcp));

    const controller = new AbortController();
    await runtime.execute(makeInput({ abortController: controller }));

    expect(runnerCalls[0].options.signal).toBe(controller.signal);
  });

  it('omits signal when no abortController is supplied', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime(makeContext(mcp));

    await runtime.execute(makeInput());

    expect(runnerCalls[0].options.signal).toBeUndefined();
  });

  it('aggregates usage across rawResponses', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime(makeContext(mcp));

    const result = await runtime.execute(makeInput());

    expect(result.turnsUsed).toBe(2);
    expect(result.usage.requests).toBe(2);
    expect(result.usage.inputTokens).toBe(300);
    expect(result.usage.outputTokens).toBe(110);
    expect(result.usage.totalTokens).toBe(410);
    expect(result.usage.reasoningTokens).toBe(30);
    expect(result.usage.cachedTokens).toBe(100);
    expect(result.rawRuntimeMetadata?.lastResponseId).toBe('resp_ok');
  });

  it('passes dryRun through toolSurface to createOpenAIMcpServer', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const ctx = makeContext(mcp);
    const runtime = new Runtime(ctx);

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a', runId: 'r', dryRun: true },
    }));

    expect(ctx.createOpenAIMcpServer).toHaveBeenCalledTimes(1);
    const forwarded = (ctx.createOpenAIMcpServer as unknown as { mock: { calls: Array<Array<Record<string, unknown>>> } }).mock.calls[0][0];
    expect(forwarded.dryRun).toBe(true);
  });

  it('round-trips lastResponseId into rawRuntimeMetadata for resume flow', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime(makeContext(mcp));

    // Simulate a resumed session where the prior run produced lastResponseId='resp_abc'
    mockRunResult.lastResponseId = 'resp_abc_next';
    const priorItems = [{ type: 'user', content: 'resume-turn' }];

    const result = await runtime.execute(makeInput({
      sessionRef: 'resume-sess',
      sessionData: priorItems,
    }));

    expect(result.rawRuntimeMetadata?.lastResponseId).toBe('resp_abc_next');
    expect(result.usage.providerData).toEqual({ lastResponseId: 'resp_abc_next' });
    // The prior items were loaded into the Session handed to Runner.run
    const session = runnerCalls[0].options.session!;
    expect(await session.getItems()).toEqual(priorItems);
  });

  it('tolerates responses without inputTokensDetails/outputTokensDetails arrays (local backends)', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime(makeContext(mcp));
    mockRunResult.rawResponses = [
      {
        usage: {
          requests: 1,
          inputTokens: 42,
          outputTokens: 7,
          totalTokens: 49,
          // No inputTokensDetails / outputTokensDetails — common for Ollama,
          // LM Studio, and llama.cpp server responses.
        },
      },
    ];

    const result = await runtime.execute(makeInput());
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.cachedTokens).toBe(0);
    expect(result.usage.reasoningTokens).toBe(0);
  });
});
