/**
 * Agent definition and task types for the intelligence agent system.
 *
 * These types describe the shape of YAML definition files (on disk)
 * and the harness/provider configuration produced by merging definitions with
 * database overrides.
 */

import type { CostResolution, CostSource } from '@myco/agent/cost/types.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import type { HarnessHooks } from './harness/hooks.js';

// ---------------------------------------------------------------------------
// YAML-sourced definitions (read from src/agent/definitions/)
// ---------------------------------------------------------------------------

/** Shape of `agent.yaml` — the built-in agent definition. */
export interface AgentDefinition {
  name: string;
  displayName: string;
  description: string;
  model: string;
  maxTurns: number;
  timeoutSeconds: number;
  systemPromptPath: string; // relative to definitions dir
  tools: string[];
}

/**
 * A single phase in a phased task pipeline.
 *
 * Phases execute in parallel waves based on their dependency graph (`dependsOn`).
 * The executor topologically sorts phases into waves — phases in the same wave
 * run concurrently via `Promise.allSettled()`. Each phase gets its own `query()`
 * call with scoped tools, turn limit, and isolated provider env.
 */
/**
 * Per-phase preCondition kinds. Distinct from the daemon's task-level
 * `PreCondition` enum because phase-level checks run at a different
 * scope (during a task run, against the pinned project DB) and answer
 * different questions ("does THIS phase have work?" vs "does the task
 * have any work at all?").
 *
 * The phase-level check is mechanical: deterministic SQL, no LLM turns.
 * When it returns false, the phase is recorded as `skipped` and no
 * harness call is made — saving the turns that would otherwise be spent
 * discovering "nothing to do" via tool calls.
 */
/**
 * Per-phase preCondition kinds — re-exported from the zero-dep tuple
 * module. The canonical list lives in `./phase-precondition-kinds.ts`;
 * adding a new kind there + a matching entry in
 * `./phase-preconditions.ts` is the whole change.
 */
import type { PhasePreConditionKind } from './phase-precondition-kinds.js';
export type { PhasePreConditionKind };

export interface PhaseDefinition {
  name: string;
  prompt: string;
  tools: string[];
  /**
   * Subset of `tools` whose full schema is withheld from the initial
   * surface (see createVaultTools's `deferredNames`). Must be a subset of
   * `tools` — enforced at YAML-load time by PhaseDefinitionSchema's
   * refine (schemas.ts), so a typo'd or stale entry fails fast instead of
   * silently narrowing to nothing. This only narrows within the phase's
   * declared tool set, never widens it.
   */
  deferredTools?: string[];
  maxTurns: number;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  required: boolean;
  /** Phase names this phase depends on. Phases with no dependencies are roots (wave 0). */
  dependsOn?: string[];
  /** Per-phase provider override. Isolated via SDK `env` option — no process.env mutation. */
  provider?: ProviderConfig;
  /** If true, prior phase summaries are omitted from the composed prompt (avoids context bloat for terminal phases). */
  skipPriorContext?: boolean;
  /** If true, the scoped tool server only includes read-only tools (readOnlyHint === true). */
  readOnly?: boolean;
  /**
   * Optional mechanical precondition. When set, the phase loop runs the
   * registered SQL check before composing the prompt; on false the phase
   * is recorded as `skipped` and the harness is not invoked. Use to
   * prevent paying for LLM turns that would only discover "no work."
   */
  preCondition?: PhasePreConditionKind;
  /**
   * Optional cross-phase skip gate. When set, the phase loop reads the
   * named upstream phase's emitted `metadata[key]` and skips THIS phase
   * unless it strictly equals `equals`. Runs BEFORE preCondition and
   * before any harness invocation — zero LLM turns when the gate
   * mismatches.
   *
   * Default-to-skip: missing upstream metadata, missing key, or value
   * mismatch all skip. The upstream phase must call `phase_emit_metadata`
   * (and therefore must list it in its `tools:` array).
   *
   * The upstream phase MUST be in an earlier wave than this phase —
   * `priorPhaseResults` only carries completed waves. Forward and
   * same-wave gates throw at YAML load time.
   */
  gateOnPriorMetadata?: PhaseGateOnPriorMetadata;

  // --- Map mode (mode === 'map') -------------------------------------------
  /** Phase execution mode. Unset/`agent` = free-form (existing). `map` = drain mode. */
  mode?: 'agent' | 'map';
  /** Map mode: per-item turn budget. Default 1 (strict). */
  perItemMaxTurns?: number;
  /** Map mode: per-item timeout in seconds. */
  perItemTimeoutSeconds?: number;
  /** Map mode: how to handle per-item harness errors. Default `skip`. */
  onItemError?: MapPhaseItemErrorPolicy;
  /** Map mode: source-block config (required when mode === 'map'). */
  source?: MapPhaseSource;
  /** Map mode: per-item config (required when mode === 'map'). */
  item?: MapPhaseItem;
  /** Map mode: sink-block config (required when mode === 'map'). */
  sink?: MapPhaseSink;
  /**
   * Map mode: optional end-of-phase accounting hook. Names a tool in the
   * registry that receives the raw source items whose disposition was a
   * genuine content failure or skip (model ran, produced no accepted write).
   * Written items and connection-unavailable items are never passed. Flushed
   * once after the per-item loop as `tool.handler({ items })`.
   */
  accounting?: { tool: string };
}

/** Result of a single phase execution within a phased run. */
export interface PhaseResult {
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  turnsUsed: number;
  tokensUsed: number;
  costUsd: number;
  costSource?: CostSource;
  costData?: CostResolution;
  summary: string; // last assistant message or error
  usage?: RuntimeUsage;
  sessionRef?: string;
  /**
   * True when the phase failed because the SDK reported "Reached maximum
   * number of turns". Set by the phase loop when classifying the error.
   * Distinct from `status: 'failed'` (any error) so cost-audit tooling
   * can count budget-exhaustion failures separately from other failures.
   */
  capHit?: boolean;
  /**
   * Turn budget the SDK was asked to enforce (the value of
   * `maxTurns` after orchestrator directives + overrides have been
   * applied). Populated alongside `capHit` so the auditor can compare
   * the budget the run was given against the budget needed.
   */
  allowedMaxTurns?: number;
  /**
   * Key→value channel populated by the phase via `phase_emit_metadata`
   * tool calls. Downstream phases gate on this via
   * `PhaseDefinition.gateOnPriorMetadata`. Persisted on PhaseCheckpoint
   * so resumed runs preserve the gate decision.
   */
  metadata?: Record<string, unknown>;
  /**
   * True when this phase's `status: 'failed'` came from
   * `snapshotFlaggedWrites` converting an otherwise-"completed" result
   * because a destructive write was blocked by the semantic check — not
   * from a hard runtime error. Persisted onto `PhaseCheckpoint` so a
   * resumed run's `reuseSession` exclusion can refuse to reattach to a
   * session whose history contains the model's own blocked tool call. See
   * `PhaseCheckpoint.semanticCheckBlocked` in executor-state.ts.
   */
  semanticCheckBlocked?: boolean;
}

/**
 * Cross-phase skip gate descriptor. See `PhaseDefinition.gateOnPriorMetadata`.
 * Strict-equality only in v1 — extend to `oneOf`/`notEquals` only when a
 * real consumer surfaces.
 */
export interface PhaseGateOnPriorMetadata {
  /** Name of the upstream phase whose metadata is the gate signal. */
  phase: string;
  /** Key in that phase's metadata to inspect. */
  key: string;
  /** Skip this phase unless metadata[key] strictly equals this value. */
  equals: string | number | boolean | null;
}

// ---------------------------------------------------------------------------
// Map-phase types
// ---------------------------------------------------------------------------

/**
 * Source-block config for a map phase. Names a tool in the agent registry
 * that the harness calls ONCE (no model) to fetch the batch of items.
 *
 * `args` values are templated via interpolate-args; null/undefined renders
 * as "arg absent" rather than "arg = null".
 *
 * `itemsPath` is the JSON path inside the tool's textResult payload to the
 * items array. Map phase parses textResult JSON and follows the path; the
 * resolved value MUST be an array.
 */
export interface MapPhaseSource {
  tool: string;
  args: Record<string, string | number | boolean | null>;
  itemsPath: string;
}

/**
 * Per-item config for a map phase. The prompt is templated against
 * { item, params }. `readTools` is an optional list of read-only tools
 * (must have readOnlyHint: true) available alongside the sink when
 * perItemMaxTurns > 1.
 */
export interface MapPhaseItem {
  prompt: string;
  readTools?: string[];
}

/**
 * Sink-block config for a map phase. Names the terminal write tool the
 * model is allowed to call. `argMap` pins harness-owned fields per item;
 * those fields are stripped from the tool's input schema before per-item
 * invocation so the model literally cannot supply them wrong. argMap
 * values are template strings rendered against `{ item, params }` via
 * interpolateArgs.
 */
export interface MapPhaseSink {
  tool: string;
  argMap: Record<string, string>;
}

export type MapPhaseItemErrorPolicy = 'skip' | 'abort';

/** Result payload for a completed map phase. */
export interface MapPhaseResult {
  itemCount: number;
  written: number;
  skipped: number;
  failed: number;
  abandoned: number;
  skipReasons: Record<string, number>;
  /**
   * Items where the wrapped sink fired ok:true but the harness later
   * threw (typically max-turns from a chatty local model that emitted
   * the tool call redundantly). Counted in `written`, not `failed` —
   * surfaced separately so chronic model-confusion is observable
   * without conflating it with genuine failures.
   */
  writeAfterThrow: number;
  /**
   * True when the phase short-circuited on provider connectivity: either the
   * pre-fetch health probe reported the provider unreachable, or a per-item
   * invocation hit a connection-class error and opened the circuit. Lets the
   * phase loop record the phase as connectivity-skipped rather than a content
   * failure.
   */
  providerUnavailable: boolean;
  /**
   * Count of items that hit a connection-class error (provider outage) before
   * the circuit opened. Tracked separately from `failed` so an unreachable
   * provider is never conflated with genuine content failures.
   */
  unavailable: number;
  /**
   * Aggregated harness usage across all per-item invocations. Token counts
   * sum across items; durations sum; cost sums where the harness reports
   * one. Map-mode runs were previously synthesizing zeros here, leaving
   * dashboards/cost-tracking blind. The aggregation happens inside
   * executeMapPhase so callers receive the real numbers.
   */
  usage: RuntimeUsage;
}

/** Context query that runs before task execution to gather vault state. */
export interface ContextQuery {
  tool: string;
  queryTemplate: string;
  limit: number;
  purpose: string;
  required: boolean;
}

/**
 * Canonical identifiers for the two built-in agent harnesses. Use these
 * constants instead of literal strings — every cross-file dispatch table,
 * config migration, provider→harness map, and test fixture should import
 * from here so a future rename happens in one place.
 */
export const HARNESS_CLAUDE_SDK = 'claude-sdk' as const;
export const HARNESS_OPENAI_AGENTS = 'openai-agents' as const;
export const BUILTIN_HARNESS_IDS = [HARNESS_CLAUDE_SDK, HARNESS_OPENAI_AGENTS] as const;
export type BuiltinHarnessId = typeof BUILTIN_HARNESS_IDS[number];
export type HarnessId = string;
export type ReasoningLevel = 'low' | 'default' | 'high';

export const PROVIDER_TYPES = [
  'anthropic',
  'ollama',
  'lmstudio',
  'openai',
  'openrouter',
  'openai-compatible',
] as const;

export type ProviderType = typeof PROVIDER_TYPES[number];

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (PROVIDER_TYPES as readonly string[]).includes(value);
}

/** API provider configuration for task execution. */
export interface ProviderConfig {
  type: ProviderType;
  localBackend?: 'ollama' | 'lmstudio';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  reasoningMap?: Partial<Record<ReasoningLevel, string>>;
  /**
   * Claude-only per-tier override of the default thinking-budget map
   * (`DEFAULT_THINKING_MAP` in `reasoning-levels.ts`). Unset tiers fall
   * back to the default. Ignored entirely for local providers — the
   * harness always forces `{ type: 'disabled' }` there regardless of
   * this map (see `resolveThinkingConfig`).
   */
  thinkingBudgetMap?: Partial<Record<ReasoningLevel, { budgetTokens: number } | { adaptive: true }>>;
  /**
   * OpenAI-only per-tier override of the default reasoning-effort /
   * verbosity map (`DEFAULT_EFFORT_MAP` in `reasoning-levels.ts`). Unset
   * tiers fall back to the default. Ignored entirely for local providers
   * — `resolveModelSettings` returns `undefined` there so no
   * `reasoning`/`text` fields are ever sent to a local backend.
   */
  effortMap?: Partial<Record<ReasoningLevel, {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    verbosity?: 'low' | 'medium' | 'high';
  }>>;
  /** Context window size for local models (Ollama num_ctx, LM Studio context_length). */
  contextLength?: number;
}

export interface RuntimeUsage {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  durationMs?: number;
  costUsd?: number | null;
  requestUsageEntries?: Array<Record<string, unknown>>;
  providerData?: Record<string, unknown>;
}

export interface RuntimeTokenBudget {
  contextWindowTokens: number | null;
  contextWindowSource?: 'provider-config' | 'provider-metadata' | 'provider-default';
  peakRequestInputTokens: number | null;
  peakRequestOutputTokens: number | null;
  peakRequestTotalTokens: number | null;
  utilizationPercent: number | null;
  headroomTokens: number | null;
  /**
   * Budget status is observability-only. `post_run_pressure` (formerly
   * `critical`) means this run hit the upper utilization band but was NOT
   * aborted — naming it `critical` misled callers into assuming it signalled
   * a pre-flight abort, which the harness never performed. A future feature
   * may add true pre-flight abort behavior behind a separate flag.
   */
  status: 'unknown' | 'ok' | 'warning' | 'post_run_pressure';
  message?: string;
}

/** Execution configuration overrides for a task. */
export interface ExecutionConfig {
  harness?: HarnessId;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  maxTurns?: number;
  timeoutSeconds?: number;
  provider?: ProviderConfig;
}

/**
 * Extended config stored as JSON in the agent_tasks.config column.
 * Structural data that doesn't fit in flat columns.
 */
export interface TaskConfig {
  phases?: PhaseDefinition[];
  execution?: ExecutionConfig;
  contextQueries?: Record<string, ContextQuery[]>;
  schemaVersion?: number;
}

/** Directive for a single phase from the orchestrator's plan. */
export interface OrchestratorPhaseDirective {
  name: string;
  skip: boolean;
  skipReason?: string;
  maxTurns?: number;
  contextNotes?: string;
}

/** The orchestrator's output — a plan for phase execution. */
export interface OrchestratorPlan {
  phases: OrchestratorPhaseDirective[];
  reasoning: string;
}

/** Orchestrator configuration on a task definition. */
export interface OrchestratorConfig {
  enabled: boolean;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  maxTurns?: number;
}

// AcceleratorName and AcceleratorConfig are exported from agent/schemas.ts
// (z.infer'd from the Zod schemas) so the enum and shape have one source
// of truth. Imported here for use in TaskSchedule below.
import type { AcceleratorConfig, AcceleratorName } from './schemas.js';
export type { AcceleratorConfig, AcceleratorName };

/** Schedule configuration for automatic task execution via PowerManager. */
export interface TaskSchedule {
  enabled: boolean;
  intervalSeconds: number;
  runIn: ('active' | 'idle' | 'sleep')[];
  preCondition?: 'has-unprocessed-batches' | 'has-active-skills' | 'has-approved-candidates' | 'has-skill-survey-evidence' | 'has-pending-canopy-rows';
  /**
   * Adaptive cadence: when present, the scheduler queries the named
   * accelerator's count function and shortens the effective interval
   * during backlog according to the declared thresholds. Optional and
   * additive — tasks without an accelerator use intervalSeconds verbatim.
   */
  accelerator?: AcceleratorConfig;
  /**
   * Hard ceiling on completed-or-failed runs in the trailing 24 hours per
   * (grove, project, task) tuple. The accelerator decides cadence within
   * the day; this caps the day. Omit to leave run frequency bounded only
   * by `intervalSeconds`.
   */
  maxRunsPerDay?: number;
}

/** Shape of each task YAML file (e.g., `tasks/vault-evolve.yaml`). */
export interface AgentTask {
  name: string;
  displayName: string;
  description: string;
  agent: string; // which agent definition this task uses
  prompt: string;
  isDefault: boolean;
  toolOverrides?: string[]; // add/remove tools
  model?: string; // override model for this task
  reasoningLevel?: ReasoningLevel; // preferred reasoning tier for this task
  maxTurns?: number; // override max turns for this task
  timeoutSeconds?: number; // override timeout for this task
  phases?: PhaseDefinition[]; // phased execution pipeline (opt-in)
  execution?: ExecutionConfig; // extended execution config
  contextQueries?: Record<string, ContextQuery[]>; // pre-execution vault queries
  isBuiltin?: boolean; // true for tasks loaded from built-in YAML definitions
  source?: string; // origin of the task (e.g., 'built-in', 'user')
  schemaVersion?: number; // schema version for the task config
  orchestrator?: OrchestratorConfig; // orchestrator configuration for phased tasks
  schedule?: TaskSchedule; // schedule configuration for automatic execution
  params?: Record<string, string | number | boolean>; // task-specific params with defaults
}

// ---------------------------------------------------------------------------
// Harness execution types (merged from definitions + DB overrides)
// ---------------------------------------------------------------------------

/**
 * The effective configuration for an agent run, produced by merging:
 * 1. Built-in AgentDefinition defaults
 * 2. AgentRow overrides from the database
 * 3. AgentTask overrides (tool list, prompt)
 */
export interface EffectiveConfig {
  agentId: string;
  harness: HarnessId;
  model: string;
  reasoningLevel?: ReasoningLevel;
  maxTurns: number;
  timeoutSeconds: number;
  systemPromptPath: string;
  tools: string[];
  taskName: string;
  taskDisplayName: string;
  taskPrompt: string;
  phases?: PhaseDefinition[];
  orchestrator?: OrchestratorConfig;
  contextQueries?: Record<string, ContextQuery[]>;
  execution?: ExecutionConfig;
  /** Resolved task params — YAML defaults merged with myco.yaml overrides. */
  taskParams?: Record<string, string | number | boolean>;
  /**
   * Propagated from RunOptions.dryRun by the executor when building the
   * effective config for this run. Passed through to the tool surface.
   */
  dryRun?: boolean;
  /**
   * Snapshotted per-run semantic-check gate, resolved once by the executor
   * from RunOptions.executionOverrides.semanticWriteCheckEnabled (Task 2b)
   * — same propagation contract as dryRun above. Passed through to the
   * tool surface so wrapToolWithSemanticCheck (tools.ts) can read it.
   */
  semanticWriteCheckEnabled?: boolean;
  /**
   * Snapshotted per-run reasoning tier for the semantic-check classifier,
   * resolved once by the executor from
   * RunOptions.executionOverrides.classifierReasoningLevel (Task 2b) —
   * same propagation contract as semanticWriteCheckEnabled above.
   * Undefined simply means "use the classifier's low default" (see
   * write-classifier.ts / tools.ts's `classifierReasoningLevel ?? 'low'`
   * ladder) — this field carries no fallback of its own.
   */
  classifierReasoningLevel?: ReasoningLevel;
}

/**
 * Minimal logger shape accepted by the agent harness for diagnostic output.
 * Structurally compatible with `DaemonLogger` so the daemon can pass its
 * logger straight in; kept here as a narrow interface so agent code never
 * imports daemon modules (that direction of dependency is inverted).
 */
export interface RunLogger {
  debug(kind: string, message: string, data?: Record<string, unknown>): void;
  info(kind: string, message: string, data?: Record<string, unknown>): void;
  warn(kind: string, message: string, data?: Record<string, unknown>): void;
  error(kind: string, message: string, data?: Record<string, unknown>): void;
}

/** Options passed to an agent run. */
export interface RunOptions {
  agentId?: string;
  task?: string;
  instruction?: string;
  /** Per-run task params layered over YAML/myco.yaml task params. */
  taskParams?: Record<string, string | number | boolean>;
  /** Resume a previous run by its ID (re-uses existing session state). */
  resumeRunId?: string;
  /** Embedding runtime for immediate vector operations during agent tool calls. */
  embeddingManager?: import('@myco/agent/runtime/ports.js').AgentEmbeddingPort;
  /** Resolved Grove/project request context for in-process vault tool access. */
  requestContext?: MycoRequestContext;
  /**
   * Optional logger. When provided (the daemon always provides one),
   * harness diagnostics are emitted at `debug` level — visible once
   * `daemon.log_level` is set to `debug`, otherwise filtered out.
   */
  logger?: RunLogger;
  /**
   * Caller-supplied lifecycle hooks. Merged additively with the default
   * audit-event hooks runAgent() always constructs — both fire, this
   * does not replace the default recorder. See agent/harness/audit-hooks.ts.
   */
  hooks?: HarnessHooks;
  /**
   * Structured metadata about the run. Populated by the dispatcher (e.g.
   * instruction-builders.ts) alongside the free-form `instruction` string
   * so the executor and tools can react without re-parsing prose.
   *
   * `candidate_id` is used by the skill-generate task-failure cleanup
   * hook to find and remove the staged SKILL.md for a failed run.
   */
  runContext?: {
    candidate_id?: string;
    cortex_instruction_input_hash?: string;
    canopy_map_inputs_hash?: string;
    skill_survey_watermark?: number;
  };
  resumeMode?: 'manual' | 'scheduled';
  /**
   * If true, all vault writes are intercepted by the scoped tool server and
   * recorded to `agent_run_write_intents` instead of mutating the DB. The
   * agent still reads live state. Used for tuning/eval runs where we want to
   * measure what the agent would do without corrupting the vault.
   */
  dryRun?: boolean;
  /**
   * Per-run execution overrides. When set, these overwrite the
   * corresponding fields on the resolved EffectiveConfig before the
   * executor enters the phase loop. Used by the Compare Runs UI for
   * A/B testing harnesses, reasoning tiers, or models against the same
   * task & vault snapshot.
   */
  executionOverrides?: {
    harness?: HarnessId;
    reasoningLevel?: ReasoningLevel;
    model?: string;
    /**
     * Full top-level provider override for this run. Wins over the task's
     * resolved provider (myco.yaml per-task override → global agent provider →
     * task YAML `execution.provider`). Use this when an operator wants to swap
     * provider/base URL/reasoning map/context length for a single run without
     * persisting to config.
     */
    provider?: ProviderConfig;
    /**
     * Per-run override/snapshot for the destructive-write semantic
     * classifier (agent.semantic_write_check_enabled). Resolved once at
     * dispatch time — either from a caller-supplied override or from
     * ResolvedRunConfig.semanticWriteCheckEnabledDefault — and persisted
     * onto agent_runs.execution_overrides so a resumed run keeps the
     * ORIGINAL dispatch's setting even if myco.yaml changes in between.
     * Same contract as dryRun (executor.ts:196).
     */
    semanticWriteCheckEnabled?: boolean;
    /**
     * Per-run override for the classifier's reasoning tier. Defaults to
     * 'low' if omitted. Follows the same resolveReasoningModel() ladder as
     * every other reasoning-level override in the harness — never a bare
     * literal in write-classifier.ts.
     */
    classifierReasoningLevel?: ReasoningLevel;
    /**
     * Per-phase overrides. Key is the phase name from the task definition.
     * When a phase name matches, its fields take precedence over the task's
     * phase default AND the top-level `executionOverrides` fields.
     *
     * Precedence for each phase, highest to lowest:
     *   1. `executionOverrides.phases[phase.name].{field}`   — most specific
     *   2. `phase.{field}` from the task YAML                — phase default
     *   3. `executionOverrides.{field}` (top-level)          — run override
     *   4. `config.{field}` from `resolveRunConfig`          — task default
     *
     * `provider` follows the same ladder: phase override → phase YAML
     * provider → top-level override → task default. `maxTurns` overrides the
     * phase's declared turn budget for this run only.
     *
     * Unknown phase names are ignored (the executor logs a one-shot warning
     * at run startup listing both the unknown keys and the real phase names).
     * Has no effect on non-phased (single-query) tasks.
     */
    phases?: Record<string, {
      reasoningLevel?: ReasoningLevel;
      model?: string;
      provider?: ProviderConfig;
      maxTurns?: number;
    }>;
  };
}

/** Result of a single agent run. */
export interface AgentRunResult {
  runId: string;
  status: 'completed' | 'failed' | 'skipped';
  reason?: string;
  tokensUsed?: number;
  costUsd?: number | null;
  costSource?: CostSource;
  costData?: CostResolution;
  error?: string;
  phases?: PhaseResult[];
  harness?: HarnessId;
  provider?: ProviderType;
  model?: string;
}
