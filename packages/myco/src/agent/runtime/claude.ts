import { query } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeExecuteInput, RuntimeExecuteResult, AgentRuntime, RuntimeCapability } from './types.js';
import { createScopedVaultToolServer, createVaultToolServer } from '@myco/agent/tools.js';
import { buildPhaseEnv } from '@myco/agent/provider.js';

const MCP_SERVER_NAME = 'myco-vault';
const PERSIST_SESSION = true;

interface ClaudeAssistantMessage {
  type: 'assistant';
  message?: { content?: Array<{ type: string; name?: string; input?: unknown }> };
}

interface ClaudeUserMessage {
  type: 'user';
  message?: { content?: Array<{ type: string; content?: unknown; is_error?: boolean }> };
}

interface ClaudeResultMessage {
  type: 'result';
  usage: {
    input_tokens?: number;
    output_tokens?: number;
  };
  total_cost_usd?: number;
  num_turns?: number;
  result?: string;
}

function buildToolServer(input: RuntimeExecuteInput) {
  const { toolSurface } = input;
  if (toolSurface.toolNames && toolSurface.toolNames.length === 0) {
    return null;
  }
  if (toolSurface.toolNames) {
    return createScopedVaultToolServer(
      toolSurface.agentId,
      toolSurface.runId,
      toolSurface.toolNames,
      {
        turnOffset: toolSurface.turnOffset,
        projectRoot: toolSurface.projectRoot,
        vaultDir: toolSurface.vaultDir,
        embeddingManager: toolSurface.embeddingManager,
        readOnly: toolSurface.readOnly,
      },
    );
  }

  return createVaultToolServer(toolSurface.agentId, toolSurface.runId, {
    embeddingManager: toolSurface.embeddingManager,
    vaultDir: toolSurface.vaultDir,
  });
}

export class ClaudeSdkRuntime implements AgentRuntime {
  readonly id = 'claude-sdk' as const;

  supports(capability: RuntimeCapability): boolean {
    return capability === 'supportsSessionResume'
      || capability === 'supportsMcp';
  }

  async execute(input: RuntimeExecuteInput): Promise<RuntimeExecuteResult> {
    const toolServer = buildToolServer(input);
    const baseEnv = buildPhaseEnv(input.provider);
    const env = { ...(baseEnv ?? process.env), MYCO_AGENT_SESSION: '1' };

    let finalText = '';
    let turnsUsed = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let assistantMessages = 0;

    for await (const message of query({
      prompt: input.prompt,
      options: {
        model: input.model,
        systemPrompt: input.systemPrompt,
        ...(toolServer ? {
          mcpServers: { [MCP_SERVER_NAME]: toolServer },
          strictMcpConfig: true,
        } : { tools: [] }),
        ...(toolServer ? { tools: [] } : {}),
        maxTurns: input.maxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: PERSIST_SESSION,
        env,
        ...(input.sessionRef ? { sessionId: input.sessionRef } : {}),
        ...(input.abortController ? { abortController: input.abortController } : {}),
      },
    })) {
      if ((message as ClaudeAssistantMessage).type === 'assistant') {
        assistantMessages += 1;
      }
      if ((message as ClaudeUserMessage).type === 'user') {
        continue;
      }
      if ((message as ClaudeResultMessage).type === 'result') {
        const resultMessage = message as ClaudeResultMessage;
        finalText = typeof resultMessage.result === 'string' ? resultMessage.result : '';
        turnsUsed = resultMessage.num_turns ?? assistantMessages;
        inputTokens = resultMessage.usage.input_tokens ?? 0;
        outputTokens = resultMessage.usage.output_tokens ?? 0;
        costUsd = resultMessage.total_cost_usd ?? 0;
      }
    }

    return {
      finalText,
      turnsUsed,
      usage: {
        requests: turnsUsed > 0 ? 1 : 0,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd,
      },
      sessionRef: input.sessionRef,
    };
  }
}
