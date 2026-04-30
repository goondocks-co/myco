import { ClaudeSdkHarness } from './claude.js';
import { OpenAIAgentsHarness } from './openai.js';
import type { AgentHarness } from './types.js';
import type { HarnessId } from '@myco/agent/types.js';

export * from './types.js';

export type AgentHarnessFactory = () => AgentHarness;

const HARNESS_REGISTRY = new Map<HarnessId, AgentHarnessFactory>();

export function registerAgentHarness(id: HarnessId, factory: AgentHarnessFactory): void {
  if (!id.trim()) throw new Error('Harness id must be non-empty');
  HARNESS_REGISTRY.set(id, factory);
}

export function getAgentHarness(harnessId: HarnessId): AgentHarness {
  const factory = HARNESS_REGISTRY.get(harnessId);
  if (!factory) {
    throw new Error(`Unknown harness id: ${harnessId}`);
  }
  return factory();
}

export function listAgentHarnessIds(): HarnessId[] {
  return [...HARNESS_REGISTRY.keys()];
}

registerAgentHarness('claude-sdk', () => new ClaudeSdkHarness());
registerAgentHarness('openai-agents', () => new OpenAIAgentsHarness());
