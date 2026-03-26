/**
 * Agent definition and task YAML loader.
 *
 * Reads agent.yaml and tasks/*.yaml from the definitions directory,
 * validates their shape, and provides helpers for merging built-in
 * definitions with database overrides into an EffectiveConfig.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from '@myco/utils/find-package-root.js';
import { parse as parseYaml } from 'yaml';
import { epochSeconds, DEFAULT_AGENT_ID, BUILT_IN_SOURCE, USER_TASK_SOURCE } from '@myco/constants.js';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertTask } from '@myco/db/queries/tasks.js';
import type { AgentRow } from '@myco/db/queries/agents.js';
import type { AgentDefinition, AgentTask, EffectiveConfig } from './types.js';
import { AgentDefinitionSchema, AgentTaskSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filename for the built-in agent definition. */
const AGENT_DEFINITION_FILE = 'agent.yaml';

/** Subdirectory containing task YAML files. */
const TASKS_SUBDIRECTORY = 'tasks';

// Package root resolution uses shared findPackageRoot from @myco/utils

// BUILT_IN_SOURCE imported from @myco/constants.js

// ---------------------------------------------------------------------------
// Definitions directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the definitions directory at runtime.
 *
 * Strategy (same pattern as `src/prompts/index.ts`):
 * 1. Walk up from `import.meta.url` looking for `package.json`.
 * 2. From package root, try `dist/src/agent/definitions/` (tsup output).
 * 3. Fall back to `src/agent/definitions/` (dev mode / tsc output).
 * 4. Also check if the current file's directory already contains agent.yaml.
 */
export function resolveDefinitionsDir(): string {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));

  // Check if we're already adjacent to the definitions (tsc output or dev mode)
  const adjacentDefs = path.join(scriptDir, 'definitions');
  if (fs.existsSync(path.join(adjacentDefs, AGENT_DEFINITION_FILE))) {
    return adjacentDefs;
  }

  // Walk up to package root using shared utility
  const root = findPackageRoot(scriptDir);
  if (root) {
    // Try dist path first (tsup bundled output)
    const distPath = path.join(root, 'dist', 'src', 'agent', 'definitions');
    if (fs.existsSync(path.join(distPath, AGENT_DEFINITION_FILE))) {
      return distPath;
    }
    // Fall back to src path (dev mode)
    const srcPath = path.join(root, 'src', 'agent', 'definitions');
    if (fs.existsSync(path.join(srcPath, AGENT_DEFINITION_FILE))) {
      return srcPath;
    }
  }

  // Final fallback: adjacent to current file
  return adjacentDefs;
}

// ---------------------------------------------------------------------------
// YAML loaders
// ---------------------------------------------------------------------------

/**
 * Load and parse the built-in agent definition from `agent.yaml`.
 *
 * @param definitionsDir — path to the definitions directory.
 * @returns the parsed AgentDefinition.
 * @throws if the file is missing or malformed.
 */
export function loadAgentDefinition(definitionsDir: string): AgentDefinition {
  const filePath = path.join(definitionsDir, AGENT_DEFINITION_FILE);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = AgentDefinitionSchema.parse(parseYaml(raw));

  return {
    name: parsed.name,
    displayName: parsed.displayName,
    description: parsed.description.trim(),
    model: parsed.model,
    maxTurns: parsed.maxTurns,
    timeoutSeconds: parsed.timeoutSeconds,
    systemPromptPath: parsed.systemPromptPath,
    tools: parsed.tools,
  };
}

/**
 * Load and parse all task YAML files from `tasks/`.
 *
 * @param definitionsDir — path to the definitions directory.
 * @returns array of parsed AgentTask objects.
 */
export function loadAgentTasks(definitionsDir: string): AgentTask[] {
  const tasksDir = path.join(definitionsDir, TASKS_SUBDIRECTORY);
  if (!fs.existsSync(tasksDir)) return [];

  const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.yaml'));
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(tasksDir, file), 'utf-8');
    const parsed = AgentTaskSchema.parse(parseYaml(raw));

    return taskFromParsed(parsed);
  });
}

/**
 * Convert a Zod-parsed task schema result to an AgentTask object.
 *
 * Shared by loadAgentTasks (built-in) and registry (user tasks) to ensure
 * all optional fields are consistently spread. Adding a new optional field
 * to AgentTaskSchema only requires updating this one function.
 */
export function taskFromParsed(parsed: AgentTask): AgentTask {
  return {
    name: parsed.name,
    displayName: parsed.displayName,
    description: parsed.description.trim(),
    agent: parsed.agent,
    prompt: parsed.prompt.trim(),
    isDefault: parsed.isDefault,
    ...(parsed.toolOverrides ? { toolOverrides: parsed.toolOverrides } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.maxTurns ? { maxTurns: parsed.maxTurns } : {}),
    ...(parsed.timeoutSeconds ? { timeoutSeconds: parsed.timeoutSeconds } : {}),
    ...(parsed.phases ? { phases: parsed.phases } : {}),
    ...(parsed.orchestrator ? { orchestrator: parsed.orchestrator } : {}),
    ...(parsed.contextQueries ? { contextQueries: parsed.contextQueries } : {}),
    ...(parsed.execution ? { execution: parsed.execution } : {}),
    ...(parsed.schemaVersion ? { schemaVersion: parsed.schemaVersion } : {}),
  };
}

/**
 * Load a system prompt markdown file.
 *
 * @param definitionsDir — path to the definitions directory.
 * @param relativePath — path relative to definitionsDir (from AgentDefinition.systemPromptPath).
 * @returns the prompt file content as a string.
 */
export function loadSystemPrompt(definitionsDir: string, relativePath: string): string {
  const filePath = path.resolve(definitionsDir, relativePath);
  return fs.readFileSync(filePath, 'utf-8').trim();
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Merge a built-in AgentDefinition with optional database overrides and
 * task-specific configuration to produce the effective runtime config.
 *
 * Priority (highest wins):
 * 1. Task toolOverrides (replaces tool list entirely if present)
 * 2. AgentRow database overrides (model, maxTurns, timeoutSeconds, tool_access)
 * 3. Built-in AgentDefinition defaults
 *
 * @param definition — the built-in agent definition from YAML.
 * @param agentOverrides — optional database row with user-applied overrides.
 * @param taskOverrides — optional task definition (determines prompt and may override tools).
 * @returns the merged EffectiveConfig.
 */
export function resolveEffectiveConfig(
  definition: AgentDefinition,
  agentOverrides?: AgentRow | null,
  taskOverrides?: AgentTask,
): EffectiveConfig {
  // Start with definition defaults
  let model = definition.model;
  let maxTurns = definition.maxTurns;
  let timeoutSeconds = definition.timeoutSeconds;
  let tools = [...definition.tools];
  const agentId = agentOverrides?.id ?? DEFAULT_AGENT_ID;

  // Apply agent DB overrides
  if (agentOverrides) {
    if (agentOverrides.model) model = agentOverrides.model;
    if (agentOverrides.max_turns !== null) maxTurns = agentOverrides.max_turns;
    if (agentOverrides.timeout_seconds !== null) timeoutSeconds = agentOverrides.timeout_seconds;
    if (agentOverrides.tool_access) {
      try {
        const parsed = JSON.parse(agentOverrides.tool_access);
        if (Array.isArray(parsed)) tools = parsed as string[];
      } catch {
        // Invalid JSON in tool_access — keep definition defaults
      }
    }
  }

  // Apply task overrides (model, turns, timeout, tool list)
  if (taskOverrides?.model) model = taskOverrides.model;
  if (taskOverrides?.maxTurns) maxTurns = taskOverrides.maxTurns;
  if (taskOverrides?.timeoutSeconds) timeoutSeconds = taskOverrides.timeoutSeconds;
  if (taskOverrides?.toolOverrides) {
    tools = [...taskOverrides.toolOverrides];
  }

  // Apply execution config overrides (highest priority)
  // Precedence: execution.model > task.model > agent.model
  if (taskOverrides?.execution) {
    if (taskOverrides.execution.model) model = taskOverrides.execution.model;
    if (taskOverrides.execution.maxTurns) maxTurns = taskOverrides.execution.maxTurns;
    if (taskOverrides.execution.timeoutSeconds) timeoutSeconds = taskOverrides.execution.timeoutSeconds;
  }

  // Task prompt and display info (fall back to a generic prompt)
  const taskName = taskOverrides?.name ?? 'full-intelligence';
  const taskDisplayName = taskOverrides?.displayName ?? 'Full Intelligence';
  const taskPrompt = taskOverrides?.prompt ?? '';

  return {
    agentId,
    model,
    maxTurns,
    timeoutSeconds,
    systemPromptPath: definition.systemPromptPath,
    tools,
    taskName,
    taskDisplayName,
    taskPrompt,
    ...(taskOverrides?.phases ? { phases: taskOverrides.phases } : {}),
    ...(taskOverrides?.orchestrator ? { orchestrator: taskOverrides.orchestrator } : {}),
    ...(taskOverrides?.contextQueries ? { contextQueries: taskOverrides.contextQueries } : {}),
    ...(taskOverrides?.execution ? { execution: taskOverrides.execution } : {}),
  };
}

// ---------------------------------------------------------------------------
// Database registration
// ---------------------------------------------------------------------------

/**
 * Register the built-in agent and all built-in tasks into the database.
 *
 * Idempotent: uses upsert (ON CONFLICT DO UPDATE) for both agent and tasks.
 * Safe to call on every daemon startup.
 *
 * @param definitionsDir — path to the definitions directory.
 */
export async function registerBuiltInAgentsAndTasks(definitionsDir: string, vaultDir?: string): Promise<void> {
  const definition = loadAgentDefinition(definitionsDir);
  const tasks = loadAgentTasks(definitionsDir);
  const now = epochSeconds();

  // Upsert the built-in agent
  registerAgent({
    id: definition.name,
    name: definition.displayName,
    model: definition.model,
    source: BUILT_IN_SOURCE,
    max_turns: definition.maxTurns,
    timeout_seconds: definition.timeoutSeconds,
    tool_access: JSON.stringify(definition.tools),
    created_at: now,
    updated_at: now,
  });

  // Upsert all built-in tasks
  for (const task of tasks) {
    upsertTask({
      id: task.name,
      agent_id: definition.name,
      source: BUILT_IN_SOURCE,
      display_name: task.displayName,
      description: task.description,
      prompt: task.prompt,
      is_default: task.isDefault ? 1 : 0,
      tool_overrides: task.toolOverrides ? JSON.stringify(task.toolOverrides) : null,
      config: JSON.stringify({
        phases: task.phases ?? null,
        execution: task.execution ?? null,
        contextQueries: task.contextQueries ?? null,
        schemaVersion: task.schemaVersion ?? 1,
      }),
      created_at: now,
      updated_at: now,
    });
  }

  // Remove built-in tasks that no longer have YAML definitions
  const validTaskIds = tasks.map(t => t.name);
  if (validTaskIds.length > 0) {
    const db = getDatabase();
    const placeholders = validTaskIds.map(() => '?').join(', ');
    db.prepare(
      `DELETE FROM agent_tasks
       WHERE source = ? AND agent_id = ? AND id NOT IN (${placeholders})`,
    ).run(BUILT_IN_SOURCE, definition.name, ...validTaskIds);
  }

  // Register user tasks from the vault (if vault dir provided)
  if (vaultDir) {
    const { loadAllTasks } = await import('./registry.js');
    const allTasks = loadAllTasks(definitionsDir, vaultDir);
    for (const [name, task] of allTasks) {
      if (task.source === USER_TASK_SOURCE) {
        upsertTask({
          id: name,
          agent_id: task.agent ?? definition.name,
          source: USER_TASK_SOURCE,
          display_name: task.displayName,
          description: task.description,
          prompt: task.prompt,
          is_default: task.isDefault ? 1 : 0,
          tool_overrides: task.toolOverrides ? JSON.stringify(task.toolOverrides) : null,
          config: JSON.stringify({
            phases: task.phases ?? null,
            execution: task.execution ?? null,
            contextQueries: task.contextQueries ?? null,
            schemaVersion: task.schemaVersion ?? 1,
          }),
          created_at: now,
          updated_at: now,
        });
      }
    }
  }
}
