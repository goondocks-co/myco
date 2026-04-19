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

/**
 * Partial telemetry a runtime attaches to a thrown error when the underlying
 * SDK burned real tokens before terminating. Without this, the phase
 * executor's catch block cannot distinguish "run crashed after spending $5"
 * from "run crashed before doing anything." Turn count lives on
 * `usage.requests` (same invariant as the success-path RuntimeExecuteResult).
 */
export interface RuntimeErrorTelemetry {
  usage: RuntimeUsage;
  sessionRef?: string;
  sessionData?: unknown;
}

/**
 * Thrown when an SDK raises an error AFTER emitting usage-bearing messages
 * (e.g., Claude SDK's max-turns error, which arrives as a result message
 * immediately followed by a throw). Carries the usage captured before the
 * throw so the caller can record accurate telemetry for the failed run.
 */
export class RuntimeExecutionError extends Error {
  readonly telemetry: RuntimeErrorTelemetry;

  constructor(message: string, telemetry: RuntimeErrorTelemetry, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RuntimeExecutionError';
    this.telemetry = telemetry;
  }
}
