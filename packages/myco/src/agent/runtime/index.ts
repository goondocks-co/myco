import { ClaudeSdkRuntime } from './claude.js';
import { OpenAIAgentsRuntime } from './openai.js';
import type { AgentRuntime } from './types.js';
import type { RuntimeId } from '@myco/agent/types.js';

export * from './types.js';

export function getAgentRuntime(runtimeId: RuntimeId): AgentRuntime {
  switch (runtimeId) {
    case 'claude-sdk':
      return new ClaudeSdkRuntime();
    case 'openai-agents':
      return new OpenAIAgentsRuntime();
    default: {
      const exhaustive: never = runtimeId;
      throw new Error(`Unknown runtime id: ${String(exhaustive)}`);
    }
  }
}
