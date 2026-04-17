import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeExecuteInput, RuntimeExecuteResult, AgentRuntime, RuntimeCapability } from './types.js';
import { createScopedVaultToolServer, createVaultToolServer } from '@myco/agent/tools.js';
import { buildPhaseEnv } from '@myco/agent/provider.js';

const MCP_SERVER_NAME = 'myco-vault';

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
    return capability === 'supportsSessionResume' || capability === 'supportsMcp';
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

    const messageStream: AsyncIterable<SDKMessage> = query({
      prompt: input.prompt,
      options: {
        model: input.model,
        systemPrompt: input.systemPrompt,
        tools: [],
        ...(toolServer
          ? { mcpServers: { [MCP_SERVER_NAME]: toolServer }, strictMcpConfig: true }
          : {}),
        maxTurns: input.maxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: true,
        env,
        ...(input.sessionRef ? { sessionId: input.sessionRef } : {}),
        ...(input.abortController ? { abortController: input.abortController } : {}),
      },
    });

    for await (const message of messageStream) {
      if (message.type === 'assistant') {
        assistantMessages += 1;
        continue;
      }
      if (message.type === 'result' && message.subtype === 'success') {
        finalText = message.result;
        turnsUsed = message.num_turns ?? assistantMessages;
        inputTokens = message.usage.input_tokens ?? 0;
        outputTokens = message.usage.output_tokens ?? 0;
        costUsd = message.total_cost_usd ?? 0;
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
        requestUsageEntries: turnsUsed > 0
          ? [{
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            }]
          : [],
      },
      sessionRef: input.sessionRef,
    };
  }
}
