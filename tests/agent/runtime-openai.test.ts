/**
 * Tests for OpenAIAgentsHarness.execute() covering the responsibilities not
 * exercised by openai-runtime.test.ts (which only tests pure helpers):
 *
 *   - PersistedSession round-trips input items on fresh + resumed runs.
 *   - mcpServer.close() runs on success AND on thrown paths (MCP lifecycle).
 *   - abortController is forwarded to Runner.run() when present.
 *   - Usage aggregation sums the rawResponses list and tolerates missing
 *     *TokensDetails arrays (local OpenAI-compatible providers).
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
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

mock.module('@openai/agents', () => {
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

mock.module('openai', () => {
  return {
    default: class OpenAI {
      constructor(public readonly config: Record<string, unknown>) {}
    },
  };
});

// ---------------------------------------------------------------------------
// Mock local-provider prep to avoid touching Ollama/LM Studio backends
// ---------------------------------------------------------------------------

mock.module('@myco/agent/ollama-context.js', () => ({
  ensureOllamaContextVariant: async (model: string) => model,
}));

mock.module('@myco/intelligence/lm-studio.js', () => ({
  LmStudioBackend: class {
    async ensureLoaded() {}
    getLoadedInstanceId() { return null; }
  },
}));

// ---------------------------------------------------------------------------
// Mock local MCP server — captures forwarded toolSurface
// ---------------------------------------------------------------------------

const mcpServerCalls: Array<Record<string, unknown>> = [];
let mockMcpServer: { connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } = {
  connect: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
};

mock.module('@myco/agent/harness/openai-local-mcp.js', () => ({
  createLocalVaultMcpServer: (toolSurface: Record<string, unknown>) => {
    mcpServerCalls.push(toolSurface);
    return mockMcpServer;
  },
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

async function loadRuntime() {
  const mod = await import('@myco/agent/harness/openai.js');
  return mod.OpenAIAgentsHarness;
}

function makeMcpServer() {
  const server = {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  mockMcpServer = server;
  return server;
}

function makeInput(overrides: Partial<import('@myco/agent/harness/types.js').HarnessExecuteInput> = {}) {
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

describe('OpenAIAgentsHarness.execute', () => {
  beforeEach(() => {
    runnerCalls.length = 0;
    mcpServerCalls.length = 0;
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
    const runtime = new Runtime();

    mockRunResult.appendItems = [{ type: 'user', content: 'hi' }];

    const result = await runtime.execute(makeInput({ sessionRef: 'sess-1', sessionData: [] }));

    expect(result.sessionData).toEqual(mockRunResult.appendItems);
    expect(result.sessionRef).toBe('sess-1');
  });

  it('hydrates prior sessionData into the Session passed to the Runner', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime();

    const priorItems = [{ type: 'user', content: 'previous turn' }];
    await runtime.execute(makeInput({ sessionRef: 'sess-resume', sessionData: priorItems }));

    expect(runnerCalls).toHaveLength(1);
    const session = runnerCalls[0].options.session!;
    expect(await session.getItems()).toEqual(priorItems);
  });

  it('calls mcpServer.close() on the successful path', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime();

    await runtime.execute(makeInput());

    expect(mcp.close).toHaveBeenCalledTimes(1);
  });

  it('calls mcpServer.close() even when the Runner throws', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime();
    mockRunBehavior = 'throw';

    await expect(runtime.execute(makeInput())).rejects.toThrow('Runner blew up');
    expect(mcp.close).toHaveBeenCalledTimes(1);
  });

  it('forwards the abortController.signal to Runner.run when provided', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime();

    const controller = new AbortController();
    await runtime.execute(makeInput({ abortController: controller }));

    expect(runnerCalls[0].options.signal).toBe(controller.signal);
  });

  it('omits signal when no abortController is supplied', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime();

    await runtime.execute(makeInput());

    expect(runnerCalls[0].options.signal).toBeUndefined();
  });

  it('aggregates usage across rawResponses', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime();

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

  it('passes dryRun through toolSurface to createLocalVaultMcpServer', async () => {
    const Runtime = await loadRuntime();
    makeMcpServer();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a', runId: 'r', dryRun: true },
    }));

    expect(mcpServerCalls).toHaveLength(1);
    expect(mcpServerCalls[0].dryRun).toBe(true);
  });

  it('round-trips lastResponseId into rawRuntimeMetadata for resume flow', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const runtime = new Runtime();

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
    const runtime = new Runtime();
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
