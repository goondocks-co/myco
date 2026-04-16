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
import type { RuntimeUsage } from '@myco/agent/types.js';
import { OPENAI_API_KEY_ENV } from '@myco/cli/providers/openai-embeddings.js';
import { OPENROUTER_API_KEY_ENV } from '@myco/cli/providers/openrouter.js';

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

  return usage;
}

function createProvider(input: RuntimeExecuteInput): OpenAIProvider {
  const baseURL = input.provider?.type === 'openrouter'
    ? (input.provider.baseUrl ?? 'https://openrouter.ai/api/v1')
    : input.provider?.type === 'openai'
      ? (input.provider.baseUrl ?? 'https://api.openai.com/v1')
      : input.provider?.baseUrl;
  const apiKey = input.provider?.apiKey
    ?? (input.provider?.type === 'openrouter' ? process.env[OPENROUTER_API_KEY_ENV] : undefined)
    ?? (input.provider?.type === 'openai' ? process.env[OPENAI_API_KEY_ENV] : undefined)
    ?? process.env.OPENAI_API_KEY;
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  return new OpenAIProvider({
    openAIClient: client,
    useResponses: true,
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
        model: input.model,
        mcpServers: [mcpServer],
      });
      const runner = new Runner({
        modelProvider: createProvider(input),
      });
      const result = await runner.run(agent, input.prompt, {
        maxTurns: input.maxTurns,
        session,
        ...(input.abortController ? { signal: input.abortController.signal } : {}),
      });

      return {
        finalText: typeof result.finalOutput === 'string'
          ? result.finalOutput
          : JSON.stringify(result.finalOutput ?? ''),
        turnsUsed: result.rawResponses.length,
        usage: toOpenAIUsage(result.rawResponses),
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
