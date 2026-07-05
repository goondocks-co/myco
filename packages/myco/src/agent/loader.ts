/**
 * Agent definition and task YAML loader.
 *
 * Reads agent.yaml and tasks/*.yaml from the definitions directory,
 * validates their shape, and provides helpers for merging built-in
 * definitions with database overrides into an EffectiveConfig.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findCorePackageRoot } from '@myco/utils/find-package-root.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { parse as parseYaml } from 'yaml';
import { epochSeconds, DEFAULT_AGENT_ID, BUILT_IN_SOURCE, USER_TASK_SOURCE } from '@myco/constants.js';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertTask } from '@myco/db/queries/tasks.js';
import type { AgentRow } from '@myco/db/queries/agents.js';
import type { AgentDefinition, AgentTask, EffectiveConfig } from './types.js';
import { HARNESS_CLAUDE_SDK } from './types.js';
import { AgentDefinitionSchema, AgentTaskSchema } from './schemas.js';
import { BUNDLED_AGENT_DEFINITION, BUNDLED_AGENT_PROMPTS, BUNDLED_AGENT_TASKS } from './definitions.generated.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filename for the built-in agent definition. */
const AGENT_DEFINITION_FILE = 'agent.yaml';

/** Subdirectory containing task YAML files. */
const TASKS_SUBDIRECTORY = 'tasks';

// Package root resolution uses shared findCorePackageRoot from @myco/utils

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

  // Walk up to @goondocks/myco core — agent definitions only ship there.
  const root = findCorePackageRoot(scriptDir);
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

function isBunVirtualPath(candidate: string): boolean {
  return candidate.startsWith('/$bunfs/') || candidate.startsWith('B:\\~BUN\\');
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
  if (isBunVirtualPath(filePath) && !fs.existsSync(filePath)) {
    return { ...BUNDLED_AGENT_DEFINITION };
  }
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
  if (!fs.existsSync(tasksDir)) {
    return isBunVirtualPath(tasksDir) ? BUNDLED_AGENT_TASKS.map((task) => ({ ...task })) : [];
  }

  const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.yaml'));
  if (files.length === 0 && isBunVirtualPath(tasksDir)) {
    return BUNDLED_AGENT_TASKS.map((task) => ({ ...task }));
  }
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
    ...(parsed.reasoningLevel ? { reasoningLevel: parsed.reasoningLevel } : {}),
    ...(parsed.maxTurns ? { maxTurns: parsed.maxTurns } : {}),
    ...(parsed.timeoutSeconds ? { timeoutSeconds: parsed.timeoutSeconds } : {}),
    ...(parsed.phases ? { phases: parsed.phases } : {}),
    ...(parsed.orchestrator ? { orchestrator: parsed.orchestrator } : {}),
    ...(parsed.contextQueries ? { contextQueries: parsed.contextQueries } : {}),
    ...(parsed.execution ? { execution: parsed.execution } : {}),
    ...(parsed.schemaVersion ? { schemaVersion: parsed.schemaVersion } : {}),
    ...(parsed.schedule ? { schedule: parsed.schedule } : {}),
    ...(parsed.params ? { params: parsed.params } : {}),
    ...(parsed.deferredTools ? { deferredTools: parsed.deferredTools } : {}),
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
  if (isBunVirtualPath(filePath) && !fs.existsSync(filePath)) {
    const bundled = BUNDLED_AGENT_PROMPTS[path.basename(relativePath)];
    if (bundled !== undefined) return bundled.trim();
  }
  return fs.readFileSync(filePath, 'utf-8').trim();
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Merge a built-in AgentDefinition with optional database overrides and
 * task-specific configuration to produce the effective harness config.
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
  let harness = taskOverrides?.execution?.harness ?? HARNESS_CLAUDE_SDK;
  // Start with definition defaults
  let model = definition.model;
  let reasoningLevel = taskOverrides?.reasoningLevel;
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
      } catch (err) {
        // Keep definition defaults but surface the error so operators can
        // tell why their per-agent tool override isn't taking effect.
        const detail = errorMessage(err);
        console.warn(
          `[agent] Ignoring malformed tool_access JSON for agent "${agentId}": ${detail}`,
        );
      }
    }
  }

  // Apply task overrides (model, turns, timeout, tool list)
  if (taskOverrides?.model) model = taskOverrides.model;
  if (taskOverrides?.reasoningLevel) reasoningLevel = taskOverrides.reasoningLevel;
  if (taskOverrides?.maxTurns) maxTurns = taskOverrides.maxTurns;
  if (taskOverrides?.timeoutSeconds) timeoutSeconds = taskOverrides.timeoutSeconds;
  if (taskOverrides?.toolOverrides) {
    tools = [...taskOverrides.toolOverrides];
  }

  // Apply execution config overrides (highest priority)
  // Precedence: execution.model > task.model > agent.model
  if (taskOverrides?.execution) {
    if (taskOverrides.execution.model) model = taskOverrides.execution.model;
    if (taskOverrides.execution.reasoningLevel) reasoningLevel = taskOverrides.execution.reasoningLevel;
    if (taskOverrides.execution.maxTurns) maxTurns = taskOverrides.execution.maxTurns;
    if (taskOverrides.execution.timeoutSeconds) timeoutSeconds = taskOverrides.execution.timeoutSeconds;
  }

  // Task prompt and display info (fall back to a generic prompt)
  const taskName = taskOverrides?.name ?? 'vault-evolve';
  const taskDisplayName = taskOverrides?.displayName ?? 'Vault Evolve';
  const taskPrompt = taskOverrides?.prompt ?? '';

  return {
    agentId,
    harness,
    model,
    ...(reasoningLevel ? { reasoningLevel } : {}),
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
    ...(taskOverrides?.deferredTools ? { deferredTools: taskOverrides.deferredTools } : {}),
  };
}

// ---------------------------------------------------------------------------
// Database registration
// ---------------------------------------------------------------------------

/**
 * JSON key inside `agents.config` (built-in agent row only) that stores the
 * content hash of the definitions the last COMPLETED seed wrote. The
 * built-in agent row's `config` column has no other writer or reader — it
 * is seed-owned (the only other `registerAgent` caller, spores/write.ts,
 * registers the separate MCP user-agent row and never sets config).
 */
const DEFINITIONS_HASH_KEY = 'definitions_hash';

interface CachedDefinitions {
  definition: AgentDefinition;
  tasks: AgentTask[];
  /** Stable content hash of the parsed definitions — see loadCachedDefinitions. */
  contentHash: string;
}

/**
 * Cached parse of the built-in agent definition + tasks, keyed by
 * definitionsDir. The YAML is process-static — resolved once per
 * directory and reused across every `seedBuiltInAgentsAndTasks` call
 * (the per-grove DB-open choke point calls this on every cache miss,
 * so re-parsing ~15 task files on each call would be wasted work).
 *
 * The content hash is computed once alongside the parse: SHA-256 over
 * `JSON.stringify` of the parsed definition + tasks with the tasks array
 * sorted by name. Sorting removes the only nondeterminism (readdir order);
 * object key order is insertion order, which is deterministic for a given
 * file content (taskFromParsed builds top-level keys in fixed code order,
 * nested objects keep YAML document order). Any semantic content change —
 * prompt, phases, config, schedule — changes the parse and therefore the
 * hash. Hashing the parse (not the raw files) also covers the bundled
 * Bun-virtual-path fallback, which has no files to hash. A change that
 * only reorders YAML keys also changes the hash, which errs on the side of
 * re-seeding (when in doubt, upsert).
 */
const definitionsCache = new Map<string, CachedDefinitions>();

function loadCachedDefinitions(definitionsDir: string): CachedDefinitions {
  const cached = definitionsCache.get(definitionsDir);
  if (cached) return cached;
  const definition = loadAgentDefinition(definitionsDir);
  const tasks = loadAgentTasks(definitionsDir);
  // Code-unit compare keeps the hash stable across host locales.
  const sortedTasks = [...tasks].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const contentHash = createHash('sha256')
    .update(JSON.stringify({ definition, tasks: sortedTasks }))
    .digest('hex');
  const loaded = { definition, tasks, contentHash };
  definitionsCache.set(definitionsDir, loaded);
  return loaded;
}

/**
 * Seed the built-in agent and all built-in tasks into the database.
 *
 * Idempotent: uses upsert (ON CONFLICT DO UPDATE) for both agent and tasks.
 * Synchronous and DB-handle-agnostic — it writes through `getDatabase()`,
 * so callers targeting a specific Grove DB must wrap the call in
 * `withDatabase(db, () => seedBuiltInAgentsAndTasks(...))`.
 *
 * Cost control: skips the upserts entirely when a cheap check shows the DB
 * already carries the current definitions. The check has two parts:
 * 1. Task id set (count + membership) — catches added/removed/renamed
 *    task YAMLs and partially-seeded DBs.
 * 2. Content marker — the SHA-256 hash of the parsed definitions, persisted
 *    in the built-in agent row's `config` column by the last COMPLETED
 *    seed. This catches content-only changes (same task ids, different
 *    prompt/phases/config) so an upgrade re-seeds every DB — boot and
 *    per-grove alike — on its next open, exactly once.
 * The marker is written LAST, after every upsert and the sweep, and the
 * agent upsert at the top clears it (config → null) first — so a seed
 * interrupted mid-way leaves no marker and re-runs in full on next open.
 * When in doubt (missing/unparseable marker, e.g. a DB last seeded by a
 * pre-marker binary), this falls through to the full upsert path —
 * correctness over cost savings.
 *
 * @param definitionsDir — path to the definitions directory.
 */
export function seedBuiltInAgentsAndTasks(definitionsDir: string): void {
  const { definition, tasks, contentHash } = loadCachedDefinitions(definitionsDir);
  const validTaskIds = tasks.map((t) => t.name);

  if (isAlreadySeeded(definition.name, validTaskIds, contentHash)) return;

  const now = epochSeconds();

  // Upsert the built-in agent. `config` is intentionally omitted (→ null):
  // the upsert clears any previous content marker, so the marker only
  // exists when the write of it below — the seed's final statement — ran.
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
  if (validTaskIds.length > 0) {
    const db = getDatabase();
    const placeholders = validTaskIds.map(() => '?').join(', ');
    db.prepare(
      `DELETE FROM agent_tasks
       WHERE source = ? AND agent_id = ? AND id NOT IN (${placeholders})`,
    ).run(BUILT_IN_SOURCE, definition.name, ...validTaskIds);
  }

  // Persist the content marker LAST — its presence means "this seed ran to
  // completion against these exact definitions". The agent upsert above
  // cleared it, so an interrupted seed leaves no marker and re-runs fully.
  getDatabase().prepare(`UPDATE agents SET config = ? WHERE id = ? AND source = ?`)
    .run(JSON.stringify({ [DEFINITIONS_HASH_KEY]: contentHash }), definition.name, BUILT_IN_SOURCE);
}

/**
 * Cheap short-circuit check for `seedBuiltInAgentsAndTasks`: true only when
 * ALL of the following hold —
 * 1. the built-in agent row exists;
 * 2. its persisted content marker (`config.definitions_hash`, written only
 *    by a completed seed) matches the current definitions hash, so
 *    content-only changes (same ids, edited prompt/phases/config) re-seed;
 * 3. the set of built-in task ids in the DB exactly matches the current
 *    YAML-derived task id set (count + membership) — a structural belt for
 *    externally deleted/injected rows the marker can't see.
 * A missing or unparseable marker (DB last seeded by a pre-marker binary,
 * or a seed that never completed) fails the check → full upsert.
 */
function isAlreadySeeded(agentId: string, validTaskIds: string[], contentHash: string): boolean {
  const db = getDatabase();
  const agentRow = db.prepare(`SELECT config FROM agents WHERE id = ? AND source = ?`)
    .get(agentId, BUILT_IN_SOURCE) as { config: string | null } | undefined;
  if (!agentRow) return false;

  if (!markerMatches(agentRow.config, contentHash)) return false;

  const existingIds = db.prepare(
    `SELECT id FROM agent_tasks WHERE source = ? AND agent_id = ?`,
  ).all(BUILT_IN_SOURCE, agentId) as Array<{ id: string }>;

  if (existingIds.length !== validTaskIds.length) return false;

  const existingSet = new Set(existingIds.map((row) => row.id));
  return validTaskIds.every((id) => existingSet.has(id));
}

/** True when the persisted agents.config marker carries the current hash. */
function markerMatches(config: string | null, contentHash: string): boolean {
  if (!config) return false;
  try {
    const parsed = JSON.parse(config) as Record<string, unknown>;
    return parsed[DEFINITIONS_HASH_KEY] === contentHash;
  } catch {
    return false;
  }
}

/**
 * Register the built-in agent and all built-in tasks into the database,
 * then (if a vault dir is provided) register user tasks discovered in the
 * vault.
 *
 * The built-in portion is synchronous (see `seedBuiltInAgentsAndTasks`)
 * and shares its short-circuit: at boot this refreshes built-ins whenever
 * the definitions' content marker (or task id set) differs from what the
 * DB carries, and skips the writes when nothing changed — an upgrade that
 * edits any built-in definition re-seeds on the next boot exactly once.
 * This wrapper stays `async` only because the user-task branch below does
 * a dynamic `import('./registry.js')`. That branch is vaultDir-dependent
 * and stays boot/bootstrap-scoped — it is NOT called from the per-grove
 * DB-open choke point (`grove-runtime-cache.ts`), which has no vaultDir in
 * scope and only needs the built-in seed. Do not move it there.
 *
 * @param definitionsDir — path to the definitions directory.
 */
export async function registerBuiltInAgentsAndTasks(definitionsDir: string, vaultDir?: string): Promise<void> {
  seedBuiltInAgentsAndTasks(definitionsDir);

  // Register user tasks from the vault (if vault dir provided)
  if (vaultDir) {
    const { definition } = loadCachedDefinitions(definitionsDir);
    const now = epochSeconds();
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
