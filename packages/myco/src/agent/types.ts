/**
 * Agent definition and task types for the intelligence agent system.
 *
 * These types describe the shape of YAML definition files (on disk)
 * and the runtime configuration produced by merging definitions with
 * database overrides.
 */

import type { CostResolution, CostSource } from '@myco/agent/cost/types.js';

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
export interface PhaseDefinition {
  name: string;
  prompt: string;
  tools: string[];
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

  // --- Map mode (mode === 'map') -------------------------------------------
  /** Phase execution mode. Unset/`agent` = free-form (existing). `map` = drain mode. */
  mode?: 'agent' | 'map';
  /** Map mode: per-item turn budget. Default 1 (strict). */
  perItemMaxTurns?: number;
  /** Map mode: per-item timeout in seconds. */
  perItemTimeoutSeconds?: number;
  /** Map mode: how to handle per-item runtime errors. Default `skip`. */
  onItemError?: MapPhaseItemErrorPolicy;
  /** Map mode: source-block config (required when mode === 'map'). */
  source?: MapPhaseSource;
  /** Map mode: per-item config (required when mode === 'map'). */
  item?: MapPhaseItem;
  /** Map mode: sink-block config (required when mode === 'map'). */
  sink?: MapPhaseSink;
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
   * Items where the wrapped sink fired ok:true but the runtime later
   * threw (typically max-turns from a chatty local model that emitted
   * the tool call redundantly). Counted in `written`, not `failed` —
   * surfaced separately so chronic model-confusion is observable
   * without conflating it with genuine failures.
   */
  writeAfterThrow: number;
  /**
   * Aggregated runtime usage across all per-item invocations. Token counts
   * sum across items; durations sum; cost sums where the runtime reports
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

export type RuntimeId = 'claude-sdk' | 'openai-agents';
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
  runtime?: RuntimeId;
  type: ProviderType;
  localBackend?: 'ollama' | 'lmstudio';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  reasoningMap?: Partial<Record<ReasoningLevel, string>>;
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
   * a pre-flight abort, which the runtime never performed. A future feature
   * may add true pre-flight abort behavior behind a separate flag.
   */
  status: 'unknown' | 'ok' | 'warning' | 'post_run_pressure';
  message?: string;
}

/** Execution configuration overrides for a task. */
export interface ExecutionConfig {
  runtime?: RuntimeId;
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
// Runtime types (merged from definitions + DB overrides)
// ---------------------------------------------------------------------------

/**
 * The effective configuration for an agent run, produced by merging:
 * 1. Built-in AgentDefinition defaults
 * 2. AgentRow overrides from the database
 * 3. AgentTask overrides (tool list, prompt)
 */
export interface EffectiveConfig {
  agentId: string;
  runtime: RuntimeId;
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
}

/**
 * Minimal logger shape accepted by the agent runtime for diagnostic output.
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
  /** Embedding manager for immediate vector operations during agent tool calls. */
  embeddingManager?: import('@myco/daemon/embedding/manager.js').EmbeddingManager;
  /**
   * Optional logger. When provided (the daemon always provides one),
   * runtime diagnostics are emitted at `debug` level — visible once
   * `daemon.log_level` is set to `debug`, otherwise filtered out.
   */
  logger?: RunLogger;
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
   * A/B testing runtimes, reasoning tiers, or models against the same
   * task & vault snapshot.
   */
  executionOverrides?: {
    runtime?: RuntimeId;
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
  runtime?: RuntimeId;
  provider?: ProviderType;
  model?: string;
}
