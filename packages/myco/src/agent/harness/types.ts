import type { MycoToolDefinition } from '@myco/agent/tools/types.js';
import type { AgentEmbeddingPort } from '@myco/agent/runtime/ports.js';
import type { ProviderConfig, RunLogger, HarnessId, RuntimeUsage, ReasoningLevel } from '@myco/agent/types.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import type { HarnessHooks, HarnessHookContext } from './hooks.js';

export type HarnessCapability =
  | 'supportsSessionResume'
  | 'supportsMcp'
  | 'structuredOutput';

export interface HarnessToolSurface {
  agentId: string;
  runId: string;
  toolNames?: string[];
  turnOffset?: number;
  projectRoot?: string;
  vaultDir?: string;
  requestContext?: MycoRequestContext;
  readOnly?: boolean;
  embeddingManager?: AgentEmbeddingPort;
  /**
   * If true, the scoped tool server wraps write-annotated tools to record
   * intents instead of mutating the vault. Set by the executor from
   * RunOptions.dryRun.
   */
  dryRun?: boolean;
  /**
   * Per-phase metadata accumulator. Threaded through from the phase loop
   * to the `phase_emit_metadata` tool so calls land back on the phase
   * loop's PhaseResult. Optional — absent for map-phase per-item surfaces,
   * single-query tasks, and anywhere the cross-phase gate is unused.
   */
  metadataAccumulator?: Map<string, unknown>;
  /**
   * Pre-materialized tool list. When set, the harness adapter MUST use
   * these tools as-is rather than rebuilding from `toolNames` via
   * createVaultTools. Required for map-phase mode, which builds a
   * constrained per-item surface (argMap-stripped sink schema +
   * outcome-capture wrapper) that would be lost if the adapter rebuilt.
   */
  tools?: MycoToolDefinition<any>[];
  /**
   * Harness-neutral lifecycle hooks (preToolUse/postToolUse). Optional —
   * absent for any caller that hasn't opted into hook emission. See
   * agent/harness/hooks.ts.
   */
  hooks?: HarnessHooks;
  /**
   * Run/phase identity bound into every hook event emitted for this tool
   * surface. Required alongside `hooks` for hook emission to actually
   * fire — `tools.ts`'s wrapToolWithAudit needs both to construct a
   * PreToolUseEvent/PostToolUseEvent.
   */
  hookContext?: HarnessHookContext;
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
  /**
   * Harness-neutral lifecycle hooks for this run. Not read by claude.ts
   * or openai.ts directly (see agent/harness/hooks.ts and the design
   * spec §4.4) — phase-loop.ts passes this through so the type carries
   * it, but hook emission itself happens inside tools.ts and phase-loop.ts,
   * not inside the harness adapters.
   */
  hooks?: HarnessHooks;
  /**
   * Optional structured-output request. When present AND the resolved
   * harness's supports('structuredOutput') is true, the harness must
   * request schema-validated output from the underlying provider and
   * return the validated object via HarnessExecuteResult.structuredOutput
   * instead of (or in addition to) finalText. Callers MUST still handle
   * a missing structuredOutput on the result (harness didn't support it,
   * or the provider's schema validation failed after retries) — never
   * assume presence.
   */
  outputSchema?: {
    /** Stable name for the schema — required by OpenAI's JsonSchemaDefinition; ignored by Claude. */
    name: string;
    schema: Record<string, unknown>;
  };
  /**
   * The reasoning tier resolved for this call. Harness adapters translate
   * this into their own provider-native thinking/reasoning-effort control
   * (Claude: `ThinkingConfig`; OpenAI: `ModelSettings.reasoning`/`text`).
   * Optional — an omitted value still resolves through each harness's
   * `default`-tier mapping for non-local providers (Claude: adaptive
   * thinking; OpenAI: the `default` tier's effort/verbosity), it does NOT
   * mean "no override sent." Only LOCAL providers (ollama/lmstudio/
   * openai-compatible) get no thinking/reasoning fields at all regardless
   * of tier, and — for OpenAI specifically — only a resolved model name the
   * SDK recognizes as GPT-5-family gets `reasoning`/`text` attached; a
   * non-reasoning-capable model name (e.g. gpt-4.1-mini, a non-GPT-5
   * openrouter route) also gets no override sent, same as a local provider.
   */
  reasoningLevel?: ReasoningLevel;
}

export interface HarnessExecuteResult {
  finalText: string;
  turnsUsed: number;
  usage: RuntimeUsage;
  sessionRef?: string;
  sessionData?: unknown;
  rawRuntimeMetadata?: Record<string, unknown>;
  /**
   * Present only when the harness both supports 'structuredOutput' and
   * the caller passed HarnessExecuteInput.outputSchema. Already validated
   * against the requested schema by the underlying provider — callers on
   * this path skip extractJson()/parse-and-hope entirely.
   */
  structuredOutput?: unknown;
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
  /** Harness-neutral lifecycle hooks — see HarnessExecuteInput.hooks doc. */
  hooks?: HarnessHooks;
  /** See `HarnessExecuteInput.reasoningLevel`. */
  reasoningLevel?: ReasoningLevel;
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
 * constraint; `'connection'` covers network and provider connectivity
 * errors (dropped connections, refused connections, DNS failures);
 * `'other'` is the residual for everything else (unparseable output,
 * tool execution failures, etc.). Cost-audit tooling counts `capHit`
 * separately from generic failures, so this classification matters at
 * the phase checkpoint level.
 */
export type HarnessErrorKind = 'max-turns' | 'connection' | 'other';

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
