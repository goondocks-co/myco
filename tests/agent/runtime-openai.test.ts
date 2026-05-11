/**
 * Tests for OpenAIAgentsHarness.execute() covering the responsibilities not
 * exercised by openai-runtime.test.ts (which only tests pure helpers):
 *
 *   - PersistedSession round-trips input items on fresh + resumed runs.
 *   - mcpServer.close() runs on success AND on thrown paths (MCP lifecycle).
 *   - abortController is forwarded to the model layer when present.
 *   - Usage aggregation sums the rawResponses list and tolerates missing
 *     *TokensDetails arrays (local OpenAI-compatible providers).
 *
 * These tests use the real @openai/agents Runner + Agent and inject a stub
 * ModelProvider via the harness's `testOverrides` constructor option. This
 * means SDK shape changes (e.g. the 0.9 MCP alignment that broke a prior
 * module-mocking approach) surface in tests immediately instead of silently
 * masking incompatibilities — the test fails loudly when the SDK contract
 * shifts.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import type {
  AgentInputItem,
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '@openai/agents';

// ---------------------------------------------------------------------------
// Local MCP server — captures forwarded toolSurface; spies for close/connect.
// ---------------------------------------------------------------------------

const mcpServerCalls: Array<Record<string, unknown>> = [];

// The real Runner reaches into the mcpServer during run (since the 0.9
// Python-SDK MCP alignment), so the stub has to implement the full
// MCPServer surface — not just connect/close.
function makeStubMcpServer() {
  return {
    name: 'myco-vault-mock',
    cacheToolsList: true,
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    invalidateToolsCache: vi.fn(async () => {}),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => []),
    listResources: vi.fn(async () => ({ resources: [] })),
    listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
    readResource: vi.fn(async () => ({ contents: [] })),
  };
}

let mockMcpServer: ReturnType<typeof makeStubMcpServer> = makeStubMcpServer();

mock.module('@myco/agent/harness/openai-local-mcp.js', () => ({
  createLocalVaultMcpServer: (toolSurface: Record<string, unknown>) => {
    mcpServerCalls.push(toolSurface);
    return mockMcpServer;
  },
}));

// ---------------------------------------------------------------------------
// Local-provider prep — avoid touching Ollama/LM Studio backends.
// (Only consulted for provider.type === 'ollama' | 'lmstudio'; defensive.)
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
// Stub ModelProvider — the seam tests inject via OpenAIAgentsHarness's
// `testOverrides`. Captures every request and serves canned responses.
// ---------------------------------------------------------------------------

interface StubResponseTemplate {
  text: string;
  responseId?: string;
  /** When set, replaces defaults wholesale (intentional — see buildResponse). */
  usage?: ModelResponse['usage'];
}

function buildResponse(template: StubResponseTemplate, index: number): ModelResponse {
  // When a test passes its own `usage`, use it verbatim — don't merge in
  // defaults, otherwise tests asserting on omitted fields (e.g. missing
  // inputTokensDetails for local backends) get tripped by leftover defaults.
  const usage = template.usage ?? {
    requests: 1,
    inputTokens: 100 * (index + 1),
    outputTokens: 50 + 10 * index,
    totalTokens: 100 * (index + 1) + 50 + 10 * index,
    inputTokensDetails: [{ cached_tokens: 40 + 20 * index }],
    outputTokensDetails: [{ reasoning_tokens: 10 + 10 * index }],
  };
  return {
    usage: usage as ModelResponse['usage'],
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: template.text }],
      } as never,
    ],
    ...(template.responseId ? { responseId: template.responseId } : {}),
  };
}

interface StubProviderState {
  provider: ModelProvider;
  requests: ModelRequest[];
  modelLookups: Array<string | undefined>;
  setResponses: (responses: StubResponseTemplate[]) => void;
  setError: (err: Error | null) => void;
}

function makeStubProvider(): StubProviderState {
  const requests: ModelRequest[] = [];
  const modelLookups: Array<string | undefined> = [];
  let responseQueue: StubResponseTemplate[] = [{ text: 'done', responseId: 'resp_default' }];
  let error: Error | null = null;

  const provider: ModelProvider = {
    getModel: (modelName?: string): Model => {
      modelLookups.push(modelName);
      return {
        async getResponse(req: ModelRequest): Promise<ModelResponse> {
          requests.push(req);
          if (error) throw error;
          const idx = Math.min(requests.length - 1, responseQueue.length - 1);
          return buildResponse(responseQueue[idx], idx);
        },
        // eslint-disable-next-line require-yield
        async *getStreamedResponse(_req: ModelRequest) {
          throw new Error('streamed responses not supported in stub');
        },
      };
    },
  };

  return {
    provider,
    requests,
    modelLookups,
    setResponses: (responses) => { responseQueue = responses; },
    setError: (err) => { error = err; },
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

async function loadRuntime() {
  const mod = await import('@myco/agent/harness/openai.js');
  return mod.OpenAIAgentsHarness;
}

function makeMcpServer() {
  const server = makeStubMcpServer();
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
    mcpServerCalls.length = 0;
  });

  it('persists assistant items into sessionData after the run', async () => {
    const Runtime = await loadRuntime();
    makeMcpServer();
    const stub = makeStubProvider();
    stub.setResponses([{ text: 'reply from assistant', responseId: 'resp_1' }]);
    const runtime = new Runtime({ modelProvider: stub.provider });

    const result = await runtime.execute(makeInput({ sessionRef: 'sess-1', sessionData: [] }));

    expect(result.sessionRef).toBe('sess-1');
    // Runner appends both the user prompt and the assistant reply to the session.
    expect(result.sessionData.length).toBeGreaterThan(0);
    const assistantItem = (result.sessionData as AgentInputItem[]).find(
      (item) => (item as { role?: string }).role === 'assistant',
    );
    expect(assistantItem).toBeDefined();
  });

  it('hydrates prior sessionData into the request sent to the model', async () => {
    const Runtime = await loadRuntime();
    makeMcpServer();
    const stub = makeStubProvider();
    const runtime = new Runtime({ modelProvider: stub.provider });

    const priorItems: AgentInputItem[] = [
      { type: 'message', role: 'user', content: 'previous turn' } as AgentInputItem,
    ];
    await runtime.execute(makeInput({ sessionRef: 'sess-resume', sessionData: priorItems }));

    expect(stub.requests).toHaveLength(1);
    const input = stub.requests[0].input;
    expect(Array.isArray(input)).toBe(true);
    // Prior items appear before the new prompt in the conversation passed to the model.
    expect(input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'previous turn' }),
      ]),
    );
  });

  it('calls mcpServer.close() on the successful path', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const stub = makeStubProvider();
    const runtime = new Runtime({ modelProvider: stub.provider });

    await runtime.execute(makeInput());

    expect(mcp.close).toHaveBeenCalledTimes(1);
  });

  it('calls mcpServer.close() even when the model throws', async () => {
    const Runtime = await loadRuntime();
    const mcp = makeMcpServer();
    const stub = makeStubProvider();
    stub.setError(new Error('Runner blew up'));
    const runtime = new Runtime({ modelProvider: stub.provider });

    await expect(runtime.execute(makeInput())).rejects.toThrow('Runner blew up');
    expect(mcp.close).toHaveBeenCalledTimes(1);
  });

  it('forwards the abortController.signal through to the model request', async () => {
    const Runtime = await loadRuntime();
    makeMcpServer();
    const stub = makeStubProvider();
    const runtime = new Runtime({ modelProvider: stub.provider });

    const controller = new AbortController();
    await runtime.execute(makeInput({ abortController: controller }));

    expect(stub.requests[0].signal).toBe(controller.signal);
  });

  it('omits the signal when no abortController is supplied', async () => {
    const Runtime = await loadRuntime();
    makeMcpServer();
    const stub = makeStubProvider();
    const runtime = new Runtime({ modelProvider: stub.provider });

    await runtime.execute(makeInput());

    expect(stub.requests[0].signal).toBeUndefined();
  });

  it('aggregates usage across rawResponses returned from the model', async () => {
    const Runtime = await loadRuntime();
    makeMcpServer();
    const stub = makeStubProvider();
    stub.setResponses([
      {
        text: 'final answer',
        responseId: 'resp_ok',
        usage: {
          requests: 1,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          inputTokensDetails: [{ cached_tokens: 40 }],
          outputTokensDetails: [{ reasoning_tokens: 10 }],
        } as ModelResponse['usage'],
      },
    ]);
    const runtime = new Runtime({ modelProvider: stub.provider });

    const result = await runtime.execute(makeInput());

    expect(result.turnsUsed).toBe(1);
    expect(result.usage.requests).toBe(1);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.totalTokens).toBe(150);
    expect(result.usage.reasoningTokens).toBe(10);
    expect(result.usage.cachedTokens).toBe(40);
    expect(result.rawRuntimeMetadata?.lastResponseId).toBe('resp_ok');
  });

  it('passes dryRun through toolSurface to createLocalVaultMcpServer', async () => {
    const Runtime = await loadRuntime();
    makeMcpServer();
    const stub = makeStubProvider();
    const runtime = new Runtime({ modelProvider: stub.provider });

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a', runId: 'r', dryRun: true },
    }));

    expect(mcpServerCalls).toHaveLength(1);
    expect(mcpServerCalls[0].dryRun).toBe(true);
  });

  it('round-trips lastResponseId into rawRuntimeMetadata for resume flow', async () => {
    const Runtime = await loadRuntime();
    makeMcpServer();
    const stub = makeStubProvider();
    stub.setResponses([{ text: 'resumed reply', responseId: 'resp_abc_next' }]);
    const runtime = new Runtime({ modelProvider: stub.provider });

    const priorItems: AgentInputItem[] = [
      { type: 'message', role: 'user', content: 'resume-turn' } as AgentInputItem,
    ];

    const result = await runtime.execute(makeInput({
      sessionRef: 'resume-sess',
      sessionData: priorItems,
    }));

    expect(result.rawRuntimeMetadata?.lastResponseId).toBe('resp_abc_next');
    expect(result.usage.providerData).toEqual({ lastResponseId: 'resp_abc_next' });
    // Prior items reached the model layer.
    expect(stub.requests[0].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'resume-turn' }),
      ]),
    );
  });

  it('tolerates responses without inputTokensDetails/outputTokensDetails arrays (local backends)', async () => {
    const Runtime = await loadRuntime();
    makeMcpServer();
    const stub = makeStubProvider();
    stub.setResponses([
      {
        text: 'local reply',
        usage: {
          requests: 1,
          inputTokens: 42,
          outputTokens: 7,
          totalTokens: 49,
          // No inputTokensDetails / outputTokensDetails — common for Ollama,
          // LM Studio, and llama.cpp server responses.
        } as ModelResponse['usage'],
      },
    ]);
    const runtime = new Runtime({ modelProvider: stub.provider });

    const result = await runtime.execute(makeInput());
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.cachedTokens).toBe(0);
    expect(result.usage.reasoningTokens).toBe(0);
  });
});
