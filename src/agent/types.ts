/**
 * Agent definition and task types for the curation agent system.
 *
 * These types describe the shape of YAML definition files (on disk)
 * and the runtime configuration produced by merging definitions with
 * database overrides.
 */

// ---------------------------------------------------------------------------
// YAML-sourced definitions (read from src/agent/definitions/)
// ---------------------------------------------------------------------------

/** Shape of `curator.yaml` — the built-in agent definition. */
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

/** Shape of each task YAML file (e.g., `tasks/full-curation.yaml`). */
export interface AgentTask {
  name: string;
  displayName: string;
  description: string;
  agent: string; // which agent definition this task uses
  prompt: string;
  isDefault: boolean;
  toolOverrides?: string[]; // add/remove tools
}

// ---------------------------------------------------------------------------
// Runtime types (merged from definitions + DB overrides)
// ---------------------------------------------------------------------------

/**
 * The effective configuration for a curation run, produced by merging:
 * 1. Built-in AgentDefinition defaults
 * 2. CuratorRow overrides from the database
 * 3. AgentTask overrides (tool list, prompt)
 */
export interface EffectiveConfig {
  curatorId: string;
  model: string;
  maxTurns: number;
  timeoutSeconds: number;
  systemPromptPath: string;
  tools: string[];
  taskName: string;
  taskDisplayName: string;
  taskPrompt: string;
}

/** Options passed to a curation agent run. */
export interface RunOptions {
  curatorId?: string;
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
}
