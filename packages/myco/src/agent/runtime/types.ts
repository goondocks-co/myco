import type { EmbeddingManager } from '@myco/daemon/embedding/manager.js';
import type { ProviderConfig, RuntimeId, RuntimeUsage } from '@myco/agent/types.js';

export type RuntimeCapability =
  | 'supportsSessionResume'
  | 'supportsMcp';

export interface RuntimeToolSurface {
  agentId: string;
  runId: string;
  toolNames?: string[];
  turnOffset?: number;
  projectRoot?: string;
  vaultDir?: string;
  readOnly?: boolean;
  embeddingManager?: EmbeddingManager;
  /**
   * If true, the scoped tool server wraps write-annotated tools to record
   * intents instead of mutating the vault. Set by the executor from
   * RunOptions.dryRun.
   */
  dryRun?: boolean;
}

export interface RuntimeExecuteInput {
  prompt: string;
  model: string;
  maxTurns?: number;
  systemPrompt?: string;
  provider?: ProviderConfig;
  toolSurface: RuntimeToolSurface;
  sessionRef?: string;
  sessionData?: unknown;
  abortController?: AbortController;
}

export interface RuntimeExecuteResult {
  finalText: string;
  turnsUsed: number;
  usage: RuntimeUsage;
  sessionRef?: string;
  sessionData?: unknown;
  rawRuntimeMetadata?: Record<string, unknown>;
}

export interface AgentRuntime {
  readonly id: RuntimeId;
  execute(input: RuntimeExecuteInput): Promise<RuntimeExecuteResult>;
  supports(capability: RuntimeCapability): boolean;
}
