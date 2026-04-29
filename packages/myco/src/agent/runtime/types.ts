import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { EmbeddingManager } from '@myco/daemon/embedding/manager.js';
import type { ProviderConfig, RunLogger, RuntimeId, RuntimeUsage } from '@myco/agent/types.js';

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
  /**
   * Pre-materialized tool list. When set, the runtime adapter MUST use
   * these tools as-is rather than rebuilding from `toolNames` via
   * createVaultTools. Required for map-phase mode, which builds a
   * constrained per-item surface (argMap-stripped sink schema +
   * outcome-capture wrapper) that would be lost if the adapter rebuilt.
   */
  tools?: SdkMcpToolDefinition<any>[];
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
  /** Optional logger for runtime-level debug diagnostics. */
  logger?: RunLogger;
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
  /**
   * Optional. Open a long-lived runtime scope for batch operations
   * (map-phase). Adapters that implement this construct the SDK-level
   * machinery (Agent, Runner, MCP server, provider client) once and
   * reuse it across multiple `scope.run()` calls. Each call still gets
   * an isolated conversation (PersistedSession or equivalent) so per-
   * item context doesn't leak — the loop fix in map-phase relies on
   * conversation isolation being preserved.
   *
   * Adapters that don't implement this leave it undefined; map-phase
   * falls back to N independent `runtime.execute()` calls.
   */
  openScope?(setup: RuntimeScopeSetup): Promise<RuntimeScope>;
}

/** One-time setup state for a runtime scope. */
export interface RuntimeScopeSetup {
  systemPrompt?: string;
  model: string;
  provider?: ProviderConfig;
  toolSurface: RuntimeToolSurface;
  logger?: RunLogger;
}

/** A long-lived runtime scope that runs N items against shared SDK machinery. */
export interface RuntimeScope {
  /** Execute one item against the long-lived scope. Conversation state is
   *  per-call — the scope shares Agent/Runner/MCP across calls but each
   *  call gets a fresh PersistedSession so per-item history is isolated. */
  run(input: RuntimeScopeRunInput): Promise<RuntimeExecuteResult>;
  /** Release scope resources (close MCP server, etc.). Idempotent. */
  close(): Promise<void>;
}

/** Per-call input for a scope.run() invocation. */
export interface RuntimeScopeRunInput {
  prompt: string;
  maxTurns?: number;
  abortController?: AbortController;
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
