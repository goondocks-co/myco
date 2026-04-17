import crypto from 'node:crypto';
import OpenAI from 'openai';
import {
  Agent,
  Runner,
  OpenAIProvider,
  type AgentInputItem,
  type Session,
} from '@openai/agents';
import type { AgentRuntime, RuntimeCapability, RuntimeExecuteInput, RuntimeExecuteResult, RuntimeFactoryContext } from './types.js';
import type { ProviderConfig, RuntimeUsage } from '@myco/agent/types.js';
import { DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS } from '@myco/agent/context-windows.js';
import { ensureOllamaContextVariant } from '@myco/agent/ollama-context.js';
import { OPENAI_API_KEY_ENV } from '@myco/cli/providers/openai-embeddings.js';
import { OPENROUTER_API_KEY_ENV } from '@myco/cli/providers/openrouter.js';
import { LmStudioBackend } from '@myco/intelligence/lm-studio.js';
import {
  getLocalOpenAIBackendDefaultBaseUrl,
  inferLocalOpenAIBackendKind,
  type LocalOpenAIBackendKind,
} from '@myco/intelligence/local-openai-backends.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
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

function toOpenAIUsage(rawResponses: Array<{
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputTokensDetails: Array<Record<string, number>>;
    outputTokensDetails: Array<Record<string, number>>;
  };
}>): RuntimeUsage {
  const usage = rawResponses.reduce(
    (acc, response) => {
      acc.requests += response.usage.requests;
      acc.inputTokens += response.usage.inputTokens;
      acc.outputTokens += response.usage.outputTokens;
      acc.totalTokens += response.usage.totalTokens;
      acc.reasoningTokens += response.usage.outputTokensDetails.reduce((sum, detail) => sum + (detail.reasoning_tokens ?? 0), 0);
      acc.cachedTokens += response.usage.inputTokensDetails.reduce((sum, detail) => sum + (detail.cached_tokens ?? 0), 0);
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

const PROVIDER_CLIENT_CONFIG_RESOLVERS: Record<ProviderConfig['type'], (provider?: ProviderConfig) => OpenAIClientConfig> = {
  anthropic: () => ({
    apiKey: process.env.OPENAI_API_KEY ?? OPENAI_COMPATIBLE_PLACEHOLDER_API_KEY,
  }),
  ollama: (provider) => ({
    apiKey: provider?.apiKey ?? OPENAI_COMPATIBLE_PLACEHOLDER_API_KEY,
    baseURL: provider?.baseUrl ?? toOpenAIBaseUrl(getLocalOpenAIBackendDefaultBaseUrl('ollama')),
  }),
  lmstudio: (provider) => ({
    apiKey: provider?.apiKey ?? OPENAI_COMPATIBLE_PLACEHOLDER_API_KEY,
    baseURL: provider?.baseUrl ?? toOpenAIBaseUrl(getLocalOpenAIBackendDefaultBaseUrl('lmstudio')),
  }),
  openai: (provider) => ({
    apiKey: provider?.apiKey ?? process.env[OPENAI_API_KEY_ENV] ?? process.env.OPENAI_API_KEY,
    baseURL: provider?.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
  }),
  openrouter: (provider) => ({
    apiKey: provider?.apiKey ?? process.env[OPENROUTER_API_KEY_ENV],
    baseURL: provider?.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
  }),
  'openai-compatible': (provider) => ({
    apiKey: provider?.apiKey ?? OPENAI_COMPATIBLE_PLACEHOLDER_API_KEY,
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

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
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

  constructor(private readonly context: RuntimeFactoryContext) {}

  supports(capability: RuntimeCapability): boolean {
    return capability === 'supportsSessionResume'
      || capability === 'supportsMcp'
      || capability === 'supportsReasoningUsageBreakdown';
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
    const mcpServer = this.context.createOpenAIMcpServer(input.toolSurface);
    await mcpServer.connect();

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
      const result = await runner.run(agent, input.prompt, {
        maxTurns: input.maxTurns,
        session,
        ...(input.abortController ? { signal: input.abortController.signal } : {}),
      });
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
}
