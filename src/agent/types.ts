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
 * Phases run sequentially — the executor controls the loop, not the LLM.
 * Each phase gets its own `query()` call with scoped tools and turn limit.
 */
export interface PhaseDefinition {
  name: string;
  prompt: string;
  tools: string[];
  maxTurns: number;
  model?: string; // override model for this phase (falls back to task/agent model)
  required: boolean;
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
  type: 'cloud' | 'ollama' | 'lmstudio';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
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
}

/** Options passed to an agent run. */
export interface RunOptions {
  agentId?: string;
  task?: string;
  instruction?: string;
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
