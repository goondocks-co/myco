/**
 * Agent definition and task YAML loader.
 *
 * Reads curator.yaml and tasks/*.yaml from the definitions directory,
 * validates their shape, and provides helpers for merging built-in
 * definitions with database overrides into an EffectiveConfig.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { parse as parseYaml } from 'yaml';
import { epochSeconds, DEFAULT_CURATOR_ID } from '@myco/constants.js';
import { registerCurator } from '@myco/db/queries/curators.js';
import { upsertTask } from '@myco/db/queries/tasks.js';
import type { CuratorRow } from '@myco/db/queries/curators.js';
import type { AgentDefinition, AgentTask, EffectiveConfig } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filename for the built-in curator definition. */
const CURATOR_DEFINITION_FILE = 'curator.yaml';

/** Subdirectory containing task YAML files. */
const TASKS_SUBDIRECTORY = 'tasks';

/** Max parent directories to walk when resolving the package root. */
const MAX_PARENT_WALK_DEPTH = 10;

/** Source label for built-in curators and tasks in the database. */
const BUILT_IN_SOURCE = 'built-in';

// ---------------------------------------------------------------------------
// Zod schemas for YAML validation
// ---------------------------------------------------------------------------

/** Schema for curator.yaml agent definition files. */
const AgentDefinitionSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  model: z.string(),
  maxTurns: z.number(),
  timeoutSeconds: z.number(),
  systemPromptPath: z.string(),
  tools: z.array(z.string()),
});

/** Schema for task YAML files in tasks/. */
const AgentTaskSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  agent: z.string(),
  prompt: z.string(),
  isDefault: z.boolean(),
  toolOverrides: z.array(z.string()).optional(),
});

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
 * 4. Also check if the current file's directory already contains curator.yaml.
 */
export function resolveDefinitionsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));

  // Check if we're already adjacent to the definitions
  const adjacentDefs = path.join(dir, 'definitions');
  if (fs.existsSync(path.join(adjacentDefs, CURATOR_DEFINITION_FILE))) {
    return adjacentDefs;
  }

  // Walk up to find package.json
  for (let i = 0; i < MAX_PARENT_WALK_DEPTH; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      // Try dist path first (tsup bundled output)
      const distPath = path.join(dir, 'dist', 'src', 'agent', 'definitions');
      if (fs.existsSync(path.join(distPath, CURATOR_DEFINITION_FILE))) {
        return distPath;
      }
      // Fall back to src path (dev mode)
      const srcPath = path.join(dir, 'src', 'agent', 'definitions');
      if (fs.existsSync(path.join(srcPath, CURATOR_DEFINITION_FILE))) {
        return srcPath;
      }
    }
    dir = path.dirname(dir);
  }

  // Final fallback: adjacent to current file
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'definitions');
}

// ---------------------------------------------------------------------------
// YAML loaders
// ---------------------------------------------------------------------------

/**
 * Load and parse the built-in agent definition from `curator.yaml`.
 *
 * @param definitionsDir — path to the definitions directory.
 * @returns the parsed AgentDefinition.
 * @throws if the file is missing or malformed.
 */
export function loadAgentDefinition(definitionsDir: string): AgentDefinition {
  const filePath = path.join(definitionsDir, CURATOR_DEFINITION_FILE);
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

    return {
      name: parsed.name,
      displayName: parsed.displayName,
      description: parsed.description.trim(),
      agent: parsed.agent,
      prompt: parsed.prompt.trim(),
      isDefault: parsed.isDefault,
      ...(parsed.toolOverrides ? { toolOverrides: parsed.toolOverrides } : {}),
    };
  });
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
 * 2. CuratorRow database overrides (model, maxTurns, timeoutSeconds, tool_access)
 * 3. Built-in AgentDefinition defaults
 *
 * @param definition — the built-in agent definition from YAML.
 * @param curatorOverrides — optional database row with user-applied overrides.
 * @param taskOverrides — optional task definition (determines prompt and may override tools).
 * @returns the merged EffectiveConfig.
 */
export function resolveEffectiveConfig(
  definition: AgentDefinition,
  curatorOverrides?: CuratorRow | null,
  taskOverrides?: AgentTask,
): EffectiveConfig {
  // Start with definition defaults
  let model = definition.model;
  let maxTurns = definition.maxTurns;
  let timeoutSeconds = definition.timeoutSeconds;
  let tools = [...definition.tools];
  const curatorId = curatorOverrides?.id ?? DEFAULT_CURATOR_ID;

  // Apply curator DB overrides
  if (curatorOverrides) {
    if (curatorOverrides.model) model = curatorOverrides.model;
    if (curatorOverrides.max_turns !== null) maxTurns = curatorOverrides.max_turns;
    if (curatorOverrides.timeout_seconds !== null) timeoutSeconds = curatorOverrides.timeout_seconds;
    if (curatorOverrides.tool_access) {
      try {
        const parsed = JSON.parse(curatorOverrides.tool_access);
        if (Array.isArray(parsed)) tools = parsed as string[];
      } catch {
        // Invalid JSON in tool_access — keep definition defaults
      }
    }
  }

  // Apply task overrides (tool list replacement)
  if (taskOverrides?.toolOverrides) {
    tools = [...taskOverrides.toolOverrides];
  }

  // Task prompt and display info (fall back to a generic prompt)
  const taskName = taskOverrides?.name ?? 'full-intelligence';
  const taskDisplayName = taskOverrides?.displayName ?? 'Full Intelligence';
  const taskPrompt = taskOverrides?.prompt ?? '';

  return {
    curatorId,
    model,
    maxTurns,
    timeoutSeconds,
    systemPromptPath: definition.systemPromptPath,
    tools,
    taskName,
    taskDisplayName,
    taskPrompt,
  };
}

// ---------------------------------------------------------------------------
// Database registration
// ---------------------------------------------------------------------------

/**
 * Register the built-in curator and all built-in tasks into the database.
 *
 * Idempotent: uses upsert (ON CONFLICT DO UPDATE) for both curator and tasks.
 * Safe to call on every daemon startup.
 *
 * @param definitionsDir — path to the definitions directory.
 */
export async function registerBuiltInCuratorsAndTasks(definitionsDir: string): Promise<void> {
  const definition = loadAgentDefinition(definitionsDir);
  const tasks = loadAgentTasks(definitionsDir);
  const now = epochSeconds();

  // Upsert the built-in curator
  await registerCurator({
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
    await upsertTask({
      id: task.name,
      curator_id: definition.name,
      source: BUILT_IN_SOURCE,
      display_name: task.displayName,
      description: task.description,
      prompt: task.prompt,
      is_default: task.isDefault ? 1 : 0,
      tool_overrides: task.toolOverrides ? JSON.stringify(task.toolOverrides) : null,
      created_at: now,
      updated_at: now,
    });
  }
}
