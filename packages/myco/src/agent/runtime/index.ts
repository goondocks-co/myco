import { createLocalVaultMcpServer } from './openai-local-mcp.js';
import { ClaudeSdkRuntime } from './claude.js';
import { OpenAIAgentsRuntime } from './openai.js';
import type { AgentRuntime } from './types.js';
import type { RuntimeId } from '@myco/agent/types.js';

export * from './types.js';

export function getAgentRuntime(runtimeId: RuntimeId): AgentRuntime {
  if (runtimeId === 'openai-agents') {
    return new OpenAIAgentsRuntime({
      createOpenAIMcpServer: (toolSurface) => createLocalVaultMcpServer(toolSurface),
    });
  }
  return new ClaudeSdkRuntime();
}
