import crypto from 'node:crypto';
import OpenAI from 'openai';
import {
  Agent,
  Runner,
  OpenAIProvider,
  type AgentInputItem,
  type Session,
} from '@openai/agents';
import {
  RuntimeExecutionError,
  type AgentRuntime,
  type RuntimeCapability,
  type RuntimeExecuteInput,
  type RuntimeExecuteResult,
  type RuntimeScope,
  type RuntimeScopeRunInput,
  type RuntimeScopeSetup,
} from './types.js';
import { createLocalVaultMcpServer } from './openai-local-mcp.js';
import type { ProviderConfig, RuntimeUsage } from '@myco/agent/types.js';
import { DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS } from '@myco/agent/context-windows.js';
import { ensureOllamaContextVariant } from '@myco/agent/ollama-context.js';
import { OPENAI_API_KEY_ENV } from '@myco/cli/providers/openai-embeddings.js';
import { OPENROUTER_API_KEY_ENV } from '@myco/cli/providers/openrouter.js';
import { LmStudioBackend } from '@myco/intelligence/lm-studio.js';
import {
  getLocalOpenAIBackendDefaultBaseUrl,
  inferLocalOpenAIBackendKind,
  tryParseUrl,
  type LocalOpenAIBackendKind,
} from '@myco/intelligence/local-openai-backends.js';
import { DEFAULT_OPENAI_URL, DEFAULT_OPENROUTER_URL } from '@myco/agent/provider.js';

const OPENAI_COMPATIBLE_PLACEHOLDER_API_KEY = 'myco-local-openai-compatible';
const OPENAI_API_PATH = '/v1';

class PersistedSession implements Session {
  private items: AgentInputItem[];
  private readonly persist: (items: AgentInputItem[]) => void;
  private readonly sessionId: string;

  constructor(sessionId: string, items: AgentInputItem[] | undefined, persist: (items: AgentInputItem[]) => void) {
    this.sessionId = sessionId;
    this.items = items ? [...items] : [];
    this.persist = persist;
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(): Promise<AgentInputItem[]> {
    return [...this.items];
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.items.push(...items);
    this.persist(this.items);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const item = this.items.pop();
    this.persist(this.items);
    return item;
  }

  async clearSession(): Promise<void> {
    this.items = [];
    this.persist(this.items);
  }
}

// Local OpenAI-compatible providers (Ollama, LM Studio, llama.cpp) commonly
// omit the *Details arrays entirely. Mark them optional so the compiler
// enforces the `?? []` guard at every call site.
function toOpenAIUsage(rawResponses: Array<{
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputTokensDetails?: Array<Record<string, number>>;
    outputTokensDetails?: Array<Record<string, number>>;
  };
}>): RuntimeUsage {
  const usage = rawResponses.reduce(
    (acc, response) => {
      acc.requests += response.usage.requests;
      acc.inputTokens += response.usage.inputTokens;
      acc.outputTokens += response.usage.outputTokens;
      acc.totalTokens += response.usage.totalTokens;
      acc.reasoningTokens += (response.usage.outputTokensDetails ?? []).reduce((sum, detail) => sum + (detail.reasoning_tokens ?? 0), 0);
      acc.cachedTokens += (response.usage.inputTokensDetails ?? []).reduce((sum, detail) => sum + (detail.cached_tokens ?? 0), 0);
      return acc;
    },
    { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
  );

  return {
    ...usage,
    requestUsageEntries: rawResponses.map((response) => ({
      ...response.usage,
    })),
  };
}

type OpenAIClientConfig = {
  apiKey?: string;
  baseURL?: string;
};

const PLACEHOLDER = OPENAI_COMPATIBLE_PLACEHOLDER_API_KEY;

const PROVIDER_CLIENT_CONFIG_RESOLVERS: Record<ProviderConfig['type'], (provider?: ProviderConfig) => OpenAIClientConfig> = {
  anthropic: () => ({
    apiKey: process.env.OPENAI_API_KEY ?? PLACEHOLDER,
  }),
  ollama: (provider) => ({
    apiKey: provider?.apiKey ?? PLACEHOLDER,
    baseURL: provider?.baseUrl ?? toOpenAIBaseUrl(getLocalOpenAIBackendDefaultBaseUrl('ollama')),
  }),
  lmstudio: (provider) => ({
    apiKey: provider?.apiKey ?? PLACEHOLDER,
    baseURL: provider?.baseUrl ?? toOpenAIBaseUrl(getLocalOpenAIBackendDefaultBaseUrl('lmstudio')),
  }),
  // Remote providers: the API key must come from the daemon's env (loaded
  // from .myco/secrets.env), never from a ProviderConfig. The baseURL is
  // locked to the hardcoded default so the bearer key cannot follow a
  // caller-supplied redirect.
  openai: () => ({
    apiKey: process.env[OPENAI_API_KEY_ENV] ?? process.env.OPENAI_API_KEY,
    baseURL: DEFAULT_OPENAI_URL,
  }),
  openrouter: () => ({
    apiKey: process.env[OPENROUTER_API_KEY_ENV],
    baseURL: DEFAULT_OPENROUTER_URL,
  }),
  'openai-compatible': (provider) => ({
    apiKey: provider?.apiKey ?? PLACEHOLDER,
    ...(provider?.baseUrl ? { baseURL: provider.baseUrl } : {}),
  }),
};

export function resolveOpenAIClientConfig(provider?: ProviderConfig): OpenAIClientConfig {
  const normalizedProvider = normalizeProviderForOpenAIClient(provider);
  const type = normalizedProvider?.type ?? 'openai';
  return PROVIDER_CLIENT_CONFIG_RESOLVERS[type](normalizedProvider);
}

export function shouldUseResponsesApi(provider?: ProviderConfig): boolean {
  return provider?.type !== 'openai-compatible'
    && provider?.type !== 'ollama'
    && provider?.type !== 'lmstudio';
}

function toOpenAIBaseUrl(baseUrl: string): string {
  const url = tryParseUrl(baseUrl);
  if (!url) return baseUrl;
  if (url.pathname === OPENAI_API_PATH || url.pathname.startsWith(`${OPENAI_API_PATH}/`)) {
    return url.toString().replace(/\/$/, '');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}${OPENAI_API_PATH}`;
  return url.toString().replace(/\/$/, '');
}

function toLocalControlBaseUrl(baseUrl: string): string {
  const url = tryParseUrl(baseUrl);
  if (!url) return baseUrl;
  if (url.pathname === OPENAI_API_PATH) {
    url.pathname = '/';
  } else if (url.pathname.startsWith(`${OPENAI_API_PATH}/`)) {
    url.pathname = url.pathname.slice(OPENAI_API_PATH.length) || '/';
  }
  return url.toString().replace(/\/$/, '');
}

function resolveLocalContextLength(provider?: ProviderConfig): number {
  return provider?.contextLength ?? DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS;
}

function normalizeProviderForOpenAIClient(provider?: ProviderConfig): ProviderConfig | undefined {
  if (!provider) return provider;
  const localBackend = inferLocalOpenAIBackendKind({
    type: provider.type,
    localBackend: provider.localBackend,
    baseUrl: provider.baseUrl,
  });
  if (!localBackend) {
    return provider;
  }
  const baseUrl = provider.baseUrl ?? getLocalOpenAIBackendDefaultBaseUrl(localBackend);
  return {
    ...provider,
    baseUrl: toOpenAIBaseUrl(baseUrl),
  };
}

async function prepareLocalProviderExecution(
  provider: ProviderConfig | undefined,
  model: string,
): Promise<{ provider: ProviderConfig | undefined; model: string }> {
  const normalizedProvider = normalizeProviderForOpenAIClient(provider);
  if (!normalizedProvider) {
    return { provider: normalizedProvider, model };
  }
  const localBackend = inferLocalOpenAIBackendKind({
    type: normalizedProvider.type,
    localBackend: normalizedProvider.localBackend,
    baseUrl: normalizedProvider.baseUrl,
  });
  if (!localBackend) {
    return { provider: normalizedProvider, model };
  }

  const contextLength = resolveLocalContextLength(normalizedProvider);
  if (localBackend === 'ollama') {
    const variantModel = await ensureOllamaContextVariant(model, contextLength);
    return {
      provider: {
        ...normalizedProvider,
        contextLength,
      },
      model: variantModel,
    };
  }

  const controlBaseUrl = toLocalControlBaseUrl(
    normalizedProvider.baseUrl ?? getLocalOpenAIBackendDefaultBaseUrl('lmstudio'),
  );
  const backend = new LmStudioBackend({
    base_url: controlBaseUrl,
    model,
    context_window: contextLength,
  });
  await backend.ensureLoaded(contextLength, false);
  return {
    provider: {
      ...normalizedProvider,
      contextLength,
    },
    model: backend.getLoadedInstanceId() ?? model,
  };
}

function createProvider(input: RuntimeExecuteInput): OpenAIProvider {
  const { apiKey, baseURL } = resolveOpenAIClientConfig(input.provider);
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  return new OpenAIProvider({
    openAIClient: client,
    useResponses: shouldUseResponsesApi(input.provider),
  });
}

export class OpenAIAgentsRuntime implements AgentRuntime {
  readonly id = 'openai-agents' as const;

  supports(capability: RuntimeCapability): boolean {
    return capability === 'supportsSessionResume' || capability === 'supportsMcp';
  }

  async execute(input: RuntimeExecuteInput): Promise<RuntimeExecuteResult> {
    const preparedExecution = await prepareLocalProviderExecution(input.provider, input.model);
    let persistedItems = Array.isArray(input.sessionData)
      ? (input.sessionData as AgentInputItem[])
      : [];
    const sessionRef = input.sessionRef ?? crypto.randomUUID();
    const session = new PersistedSession(sessionRef, persistedItems, (items) => {
      persistedItems = [...items];
    });
    const mcpServer = createLocalVaultMcpServer(input.toolSurface);
    await mcpServer.connect();

    // Capture rawResponses progressively so usage telemetry survives a
    // mid-run throw (max-turns errors fire AFTER the SDK has consumed
    // tokens). The runner's `state` exposes accumulated responses on the
    // error; we also defensively peek into the error itself.
    try {
      const agent = new Agent({
        name: 'myco-agent',
        instructions: input.systemPrompt ?? 'You are the Myco agent runtime.',
        model: preparedExecution.model,
        mcpServers: [mcpServer],
      });
      const runner = new Runner({
        modelProvider: createProvider({
          ...input,
          provider: preparedExecution.provider,
        }),
      });
      let result;
      try {
        result = await runner.run(agent, input.prompt, {
          maxTurns: input.maxTurns,
          session,
          ...(input.abortController ? { signal: input.abortController.signal } : {}),
        });
      } catch (err) {
        // Best-effort usage extraction. SDK errors from max-turns and tool
        // failures often carry the partial rawResponses on a `state` or
        // `result` field; we try the common shapes and fall back to an
        // empty usage if none match.
        const partialRaw = extractPartialRawResponses(err);
        const usage = partialRaw ? toOpenAIUsage(partialRaw) : ({} as RuntimeUsage);
        throw new RuntimeExecutionError(
          err instanceof Error ? err.message : String(err),
          { usage, sessionRef, sessionData: persistedItems },
          { cause: err instanceof Error ? err : undefined },
        );
      }
      const usage = toOpenAIUsage(result.rawResponses);
      usage.providerData = {
        lastResponseId: result.lastResponseId,
      };

      return {
        finalText: typeof result.finalOutput === 'string'
          ? result.finalOutput
          : JSON.stringify(result.finalOutput ?? ''),
        turnsUsed: result.rawResponses.length,
        usage,
        sessionRef,
        sessionData: persistedItems,
        rawRuntimeMetadata: {
          lastResponseId: result.lastResponseId,
        },
      };
    } finally {
      await mcpServer.close();
    }
  }

  async openScope(setup: RuntimeScopeSetup): Promise<RuntimeScope> {
    // One-time setup: prepare provider/model, construct MCP server +
    // Agent + Runner + provider client. These are shared across every
    // scope.run() call, eliminating ~10x of SDK setup work that the
    // map-phase per-item flow used to do via repeated execute() calls.
    // Conversation state is NOT shared — each scope.run() builds a fresh
    // PersistedSession so per-item history is isolated (load-bearing
    // for map-phase's loop fix).
    const preparedExecution = await prepareLocalProviderExecution(setup.provider, setup.model);
    const mcpServer = createLocalVaultMcpServer(setup.toolSurface);
    await mcpServer.connect();

    const agent = new Agent({
      name: 'myco-agent',
      instructions: setup.systemPrompt ?? 'You are the Myco agent runtime.',
      model: preparedExecution.model,
      mcpServers: [mcpServer],
    });
    const runner = new Runner({
      modelProvider: createProvider({
        provider: preparedExecution.provider,
      } as RuntimeExecuteInput),
    });

    let closed = false;

    return {
      async run(input: RuntimeScopeRunInput): Promise<RuntimeExecuteResult> {
        if (closed) throw new Error('OpenAIAgentsRuntime: scope.run() called after close()');
        const sessionRef = crypto.randomUUID();
        let persistedItems: AgentInputItem[] = [];
        const session = new PersistedSession(sessionRef, persistedItems, (items) => {
          persistedItems = [...items];
        });
        let result;
        try {
          result = await runner.run(agent, input.prompt, {
            maxTurns: input.maxTurns,
            session,
            ...(input.abortController ? { signal: input.abortController.signal } : {}),
          });
        } catch (err) {
          const partialRaw = extractPartialRawResponses(err);
          const usage = partialRaw ? toOpenAIUsage(partialRaw) : ({} as RuntimeUsage);
          throw new RuntimeExecutionError(
            err instanceof Error ? err.message : String(err),
            { usage, sessionRef, sessionData: persistedItems },
            { cause: err instanceof Error ? err : undefined },
          );
        }
        const usage = toOpenAIUsage(result.rawResponses);
        usage.providerData = { lastResponseId: result.lastResponseId };
        return {
          finalText: typeof result.finalOutput === 'string'
            ? result.finalOutput
            : JSON.stringify(result.finalOutput ?? ''),
          turnsUsed: result.rawResponses.length,
          usage,
          sessionRef,
          sessionData: persistedItems,
          rawRuntimeMetadata: { lastResponseId: result.lastResponseId },
        };
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await mcpServer.close();
      },
    };
  }
}

/**
 * Try to pull `rawResponses` (the accumulated LLM round-trips) off a
 * thrown SDK error so the caller still gets usage telemetry on failure.
 * The shape varies across SDK versions and error types — we check the
 * common ones and return undefined if none match.
 */
function extractPartialRawResponses(err: unknown): Array<Parameters<typeof toOpenAIUsage>[0][number]> | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const candidates: unknown[] = [
    (err as { rawResponses?: unknown }).rawResponses,
    (err as { state?: { rawResponses?: unknown } }).state?.rawResponses,
    (err as { result?: { rawResponses?: unknown } }).result?.rawResponses,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as Array<Parameters<typeof toOpenAIUsage>[0][number]>;
  }
  return undefined;
}
