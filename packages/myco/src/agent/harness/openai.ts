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
  HarnessExecutionError,
  type AgentHarness,
  type HarnessCapability,
  type HarnessExecuteInput,
  type HarnessExecuteResult,
  type HarnessScope,
  type HarnessScopeRunInput,
  type HarnessScopeSetup,
} from './types.js';
import { createLocalVaultMcpServer } from './openai-local-mcp.js';
import type { ProviderConfig, RuntimeUsage } from '@myco/agent/types.js';
import { HARNESS_OPENAI_AGENTS } from '@myco/agent/types.js';
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
import { errorMessage } from '@myco/utils/error-message.js';

const OPENAI_COMPATIBLE_PLACEHOLDER_API_KEY = 'myco-local-openai-compatible';
const OPENAI_API_PATH = '/v1';
const SESSION_RESUME_ERROR_PATTERNS = [
  /session/i,
  /resume/i,
  /previous[_ ]response/i,
  /conversation/i,
];

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

function createProvider(provider: ProviderConfig | undefined): OpenAIProvider {
  const { apiKey, baseURL } = resolveOpenAIClientConfig(provider);
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  return new OpenAIProvider({
    openAIClient: client,
    useResponses: shouldUseResponsesApi(provider),
  });
}

/**
 * Drive a single SDK turn-loop with a configured runner+agent. Used by
 * both `OpenAIAgentsHarness.execute` (which feeds in any prior session
 * data + sessionRef) and `scope.run` (always a fresh session). Centralized
 * here so usage accounting, partial-usage rescue on throw, and result-shape
 * construction stay in one place — without it the two call sites had
 * already drifted.
 */
async function runOpenAIAgent(
  runner: Runner,
  agent: Agent,
  prompt: string,
  options: {
    maxTurns?: number;
    sessionRef: string;
    sessionData: AgentInputItem[];
    abortController?: AbortController;
  },
): Promise<HarnessExecuteResult> {
  let persistedItems: AgentInputItem[] = [...options.sessionData];
  const session = new PersistedSession(options.sessionRef, persistedItems, (items) => {
    persistedItems = [...items];
  });

  let result;
  try {
    result = await runner.run(agent, prompt, {
      maxTurns: options.maxTurns,
      session,
      ...(options.abortController ? { signal: options.abortController.signal } : {}),
    });
  } catch (err) {
    const partialRaw = extractPartialRawResponses(err);
    const usage = partialRaw ? toOpenAIUsage(partialRaw) : ({} as RuntimeUsage);
    throw new HarnessExecutionError(
      err instanceof Error ? err.message : String(err),
      { usage, sessionRef: options.sessionRef, sessionData: persistedItems },
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
    sessionRef: options.sessionRef,
    sessionData: persistedItems,
    rawRuntimeMetadata: { lastResponseId: result.lastResponseId },
  };
}

export class OpenAIAgentsHarness implements AgentHarness {
  readonly id = HARNESS_OPENAI_AGENTS;

  supports(capability: HarnessCapability): boolean {
    return capability === 'supportsSessionResume' || capability === 'supportsMcp';
  }

  classifyError(error: unknown) {
    const message = errorMessage(error);
    return SESSION_RESUME_ERROR_PATTERNS.some((pattern) => pattern.test(message))
      ? 'session-resume-failed' as const
      : 'unknown' as const;
  }

  async execute(input: HarnessExecuteInput): Promise<HarnessExecuteResult> {
    const preparedExecution = await prepareLocalProviderExecution(input.provider, input.model);
    const mcpServer = createLocalVaultMcpServer(input.toolSurface);
    await mcpServer.connect();

    try {
      const agent = new Agent({
        name: 'myco-agent',
        instructions: input.systemPrompt ?? 'You are the Myco agent harness.',
        model: preparedExecution.model,
        mcpServers: [mcpServer],
      });
      const runner = new Runner({
        modelProvider: createProvider(preparedExecution.provider),
      });
      return await runOpenAIAgent(runner, agent, input.prompt, {
        maxTurns: input.maxTurns,
        sessionRef: input.sessionRef ?? crypto.randomUUID(),
        sessionData: Array.isArray(input.sessionData) ? (input.sessionData as AgentInputItem[]) : [],
        abortController: input.abortController,
      });
    } finally {
      await mcpServer.close();
    }
  }

  async openScope(setup: HarnessScopeSetup): Promise<HarnessScope> {
    const preparedExecution = await prepareLocalProviderExecution(setup.provider, setup.model);
    const mcpServer = createLocalVaultMcpServer(setup.toolSurface);
    await mcpServer.connect();

    const agent = new Agent({
      name: 'myco-agent',
      instructions: setup.systemPrompt ?? 'You are the Myco agent harness.',
      model: preparedExecution.model,
      mcpServers: [mcpServer],
    });
    const runner = new Runner({
      modelProvider: createProvider(preparedExecution.provider),
    });

    let closed = false;

    return {
      async run(input: HarnessScopeRunInput): Promise<HarnessExecuteResult> {
        if (closed) throw new Error('OpenAIAgentsHarness: scope.run() called after close()');
        return runOpenAIAgent(runner, agent, input.prompt, {
          maxTurns: input.maxTurns,
          sessionRef: crypto.randomUUID(),
          sessionData: [],
          abortController: input.abortController,
        });
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
