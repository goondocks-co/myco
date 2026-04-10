/**
 * Agent definition and task types for the intelligence agent system.
 *
 * These types describe the shape of YAML definition files (on disk)
 * and the runtime configuration produced by merging definitions with
 * database overrides.
 */

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
  required: boolean;
  /** Phase names this phase depends on. Phases with no dependencies are roots (wave 0). */
  dependsOn?: string[];
  /** Per-phase provider override. Isolated via SDK `env` option — no process.env mutation. */
  provider?: ProviderConfig;
  /** If true, prior phase summaries are omitted from the composed prompt (avoids context bloat for terminal phases). */
  skipPriorContext?: boolean;
  /** If true, the scoped tool server only includes read-only tools (readOnlyHint === true). */
  readOnly?: boolean;
}

/** Result of a single phase execution within a phased run. */
export interface PhaseResult {
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  turnsUsed: number;
  tokensUsed: number;
  costUsd: number;
  summary: string; // last assistant message or error
}

/** Context query that runs before task execution to gather vault state. */
export interface ContextQuery {
  tool: string;
  queryTemplate: string;
  limit: number;
  purpose: string;
  required: boolean;
}

/** API provider configuration for task execution. */
export interface ProviderConfig {
  type: 'anthropic' | 'ollama' | 'lmstudio';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Context window size for local models (Ollama num_ctx, LM Studio context_length). */
  contextLength?: number;
}

/** Execution configuration overrides for a task. */
export interface ExecutionConfig {
  model?: string;
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
  maxTurns?: number;
}

/** Schedule configuration for automatic task execution via PowerManager. */
export interface TaskSchedule {
  enabled: boolean;
  intervalSeconds: number;
  runIn: ('active' | 'idle' | 'sleep')[];
  preCondition?: 'has-unprocessed-batches' | 'has-active-skills' | 'has-approved-candidates';
}

/** Shape of each task YAML file (e.g., `tasks/full-intelligence.yaml`). */
export interface AgentTask {
  name: string;
  displayName: string;
  description: string;
  agent: string; // which agent definition this task uses
  prompt: string;
  isDefault: boolean;
  toolOverrides?: string[]; // add/remove tools
  model?: string; // override model for this task
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
  model: string;
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
}

/** Options passed to an agent run. */
export interface RunOptions {
  agentId?: string;
  task?: string;
  instruction?: string;
  /** Resume a previous run by its ID (re-uses existing session state). */
  resumeRunId?: string;
  /** Embedding manager for immediate vector operations during agent tool calls. */
  embeddingManager?: import('@myco/daemon/embedding/manager.js').EmbeddingManager;
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
  };
}

/** Result of a single agent run. */
export interface AgentRunResult {
  runId: string;
  status: 'completed' | 'failed' | 'skipped';
  reason?: string;
  tokensUsed?: number;
  costUsd?: number;
  error?: string;
  phases?: PhaseResult[];
}
