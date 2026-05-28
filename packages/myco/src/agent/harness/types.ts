import type { MycoToolDefinition } from '@myco/agent/tools/types.js';
import type { EmbeddingManager } from '@myco/daemon/embedding/manager.js';
import type { ProviderConfig, RunLogger, HarnessId, RuntimeUsage } from '@myco/agent/types.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';

export type HarnessCapability =
  | 'supportsSessionResume'
  | 'supportsMcp';

export interface HarnessToolSurface {
  agentId: string;
  runId: string;
  toolNames?: string[];
  turnOffset?: number;
  projectRoot?: string;
  vaultDir?: string;
  requestContext?: MycoRequestContext;
  readOnly?: boolean;
  embeddingManager?: EmbeddingManager;
  /**
   * If true, the scoped tool server wraps write-annotated tools to record
   * intents instead of mutating the vault. Set by the executor from
   * RunOptions.dryRun.
   */
  dryRun?: boolean;
  /**
   * Pre-materialized tool list. When set, the harness adapter MUST use
   * these tools as-is rather than rebuilding from `toolNames` via
   * createVaultTools. Required for map-phase mode, which builds a
   * constrained per-item surface (argMap-stripped sink schema +
   * outcome-capture wrapper) that would be lost if the adapter rebuilt.
   */
  tools?: MycoToolDefinition<any>[];
}

export interface HarnessExecuteInput {
  prompt: string;
  model: string;
  maxTurns?: number;
  systemPrompt?: string;
  provider?: ProviderConfig;
  toolSurface: HarnessToolSurface;
  sessionRef?: string;
  sessionData?: unknown;
  abortController?: AbortController;
  /** Optional logger for harness-level debug diagnostics. */
  logger?: RunLogger;
}

export interface HarnessExecuteResult {
  finalText: string;
  turnsUsed: number;
  usage: RuntimeUsage;
  sessionRef?: string;
  sessionData?: unknown;
  rawRuntimeMetadata?: Record<string, unknown>;
}

export interface AgentHarness {
  readonly id: HarnessId;
  execute(input: HarnessExecuteInput): Promise<HarnessExecuteResult>;
  supports(capability: HarnessCapability): boolean;
  classifyError?(error: unknown, context?: { attemptedResume?: boolean }): 'session-resume-failed' | 'session-expired' | 'unknown';
  /**
   * Optional. Open a long-lived harness scope for batch operations
   * (map-phase). Adapters that implement this construct the SDK-level
   * machinery (Agent, Runner, MCP server, provider client) once and
   * reuse it across multiple `scope.run()` calls. Each call still gets
   * an isolated conversation (PersistedSession or equivalent) so per-
   * item context doesn't leak — the loop fix in map-phase relies on
   * conversation isolation being preserved.
   *
   * Adapters that don't implement this leave it undefined; map-phase
   * falls back to N independent `harness.execute()` calls.
   */
  openScope?(setup: HarnessScopeSetup): Promise<HarnessScope>;
}

/** One-time setup state for a harness scope. */
export interface HarnessScopeSetup {
  systemPrompt?: string;
  model: string;
  provider?: ProviderConfig;
  toolSurface: HarnessToolSurface;
  logger?: RunLogger;
}

/** A long-lived harness scope that runs N items against shared SDK machinery. */
export interface HarnessScope {
  /** Execute one item against the long-lived scope. Conversation state is
   *  per-call — the scope shares Agent/Runner/MCP across calls but each
   *  call gets a fresh PersistedSession so per-item history is isolated. */
  run(input: HarnessScopeRunInput): Promise<HarnessExecuteResult>;
  /** Release scope resources (close MCP server, etc.). Idempotent. */
  close(): Promise<void>;
}

/** Per-call input for a scope.run() invocation. */
export interface HarnessScopeRunInput {
  prompt: string;
  maxTurns?: number;
  abortController?: AbortController;
}

/**
 * Partial telemetry a harness attaches to a thrown error when the underlying
 * SDK burned real tokens before terminating. Without this, the phase
 * executor's catch block cannot distinguish "run crashed after spending $5"
 * from "run crashed before doing anything." Turn count lives on
 * `usage.requests` (same invariant as the success-path HarnessExecuteResult).
 */
/**
 * Classification of HarnessExecutionError causes. Set by the adapter at
 * the throw site where the SDK's error type/wording is authoritative.
 * `'max-turns'` means the configured maxTurns budget was the binding
 * constraint; `'other'` covers everything else (timeouts, network,
 * tool execution, etc.). Cost-audit tooling counts `capHit` separately
 * from generic failures, so this classification matters at the phase
 * checkpoint level.
 */
export type HarnessErrorKind = 'max-turns' | 'other';

export interface HarnessErrorTelemetry {
  usage: RuntimeUsage;
  sessionRef?: string;
  sessionData?: unknown;
  kind?: HarnessErrorKind;
}

/**
 * Thrown when an SDK raises an error AFTER emitting usage-bearing messages
 * (e.g., Claude SDK's max-turns error, which arrives as a result message
 * immediately followed by a throw). Carries the usage captured before the
 * throw so the caller can record accurate telemetry for the failed run.
 */
export class HarnessExecutionError extends Error {
  readonly telemetry: HarnessErrorTelemetry;

  constructor(message: string, telemetry: HarnessErrorTelemetry, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HarnessExecutionError';
    this.telemetry = telemetry;
  }
}
