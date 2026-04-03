/**
 * Config resolution for agent runs.
 *
 * Centralizes the multi-source config merging that was previously scattered
 * through `runAgent()`:
 *   1. Agent definition from YAML (via loader)
 *   2. Agent DB row overrides
 *   3. Task DB row + registry YAML (structural fields)
 *   4. myco.yaml provider overrides (global, per-task, per-phase)
 *
 * Export: `resolveRunConfig()` — produces the fully resolved config with all
 * overrides applied in a single call.
 */

import { getAgent } from '@myco/db/queries/agents.js';
import { getTask, getDefaultTask } from '@myco/db/queries/tasks.js';
import {
  resolveDefinitionsDir,
  loadAgentDefinition,
  resolveEffectiveConfig,
} from './loader.js';
import { loadAllTasks } from './registry.js';
import { loadConfig } from '@myco/config/loader.js';
import type { ProviderConfig, EffectiveConfig } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fully resolved run configuration with all overrides applied. */
export interface ResolvedRunConfig {
  /** Merged effective config (definition + DB + task + execution). */
  config: EffectiveConfig;
  /** Resolved definitions directory path. */
  definitionsDir: string;
  /** Task-level provider override from myco.yaml (global or per-task). */
  taskProviderOverride?: ProviderConfig;
  /** Per-phase provider/maxTurns overrides from myco.yaml. */
  phaseProviderOverrides: Record<string, { provider?: ProviderConfig; maxTurns?: number }>;
  /** Effective task name (from DB or options). */
  taskName?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a myco.yaml snake_case provider to the runtime camelCase ProviderConfig.
 *
 * API keys are NOT stored in myco.yaml — they flow via env vars
 * (settings.json -> hooks -> daemon).
 */
function toProviderConfig(p: {
  type: 'cloud' | 'ollama' | 'lmstudio';
  base_url?: string;
  model?: string;
  context_length?: number;
}): ProviderConfig {
  return {
    type: p.type,
    baseUrl: p.base_url,
    model: p.model,
    contextLength: p.context_length,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the full run configuration from all sources.
 *
 * Merges:
 * 1. Built-in AgentDefinition (YAML)
 * 2. Agent DB row overrides
 * 3. Task DB row + YAML registry structural fields (phases, execution, etc.)
 * 4. myco.yaml provider overrides (global, per-task, per-phase)
 *
 * @param agentId — agent identifier.
 * @param requestedTask — optional task name from RunOptions.
 * @param vaultDir — absolute path to the vault directory.
 * @returns the fully resolved config bundle.
 */
export function resolveRunConfig(
  agentId: string,
  requestedTask: string | undefined,
  vaultDir: string,
): ResolvedRunConfig {
  const definitionsDir = resolveDefinitionsDir();
  const definition = loadAgentDefinition(definitionsDir);

  // Load agent and task — both are sync DB lookups
  const agentRow = getAgent(agentId);
  const taskRow = requestedTask
    ? getTask(requestedTask)
    : getDefaultTask(agentId);

  // Structural fields (phases, execution, contextQueries) come from the registry
  // (built-in YAML merged with user vault tasks) rather than the DB flat columns.
  const allTasks = loadAllTasks(definitionsDir, vaultDir);
  const taskName = taskRow?.id ?? requestedTask;
  const yamlTask = taskName ? allTasks.get(taskName) : undefined;

  const taskOverrides = taskRow
    ? {
        name: taskRow.id,
        displayName: taskRow.display_name ?? taskRow.id,
        description: taskRow.description ?? '',
        agent: taskRow.agent_id,
        prompt: taskRow.prompt,
        isDefault: taskRow.is_default === 1,
        ...(taskRow.tool_overrides
          ? { toolOverrides: JSON.parse(taskRow.tool_overrides) as string[] }
          : {}),
        // Scalar config from YAML (model, turns, timeout) — DB doesn't store these
        ...(yamlTask?.model ? { model: yamlTask.model } : {}),
        ...(yamlTask?.maxTurns ? { maxTurns: yamlTask.maxTurns } : {}),
        ...(yamlTask?.timeoutSeconds ? { timeoutSeconds: yamlTask.timeoutSeconds } : {}),
        // Structural config from YAML
        ...(yamlTask?.phases ? { phases: yamlTask.phases } : {}),
        ...(yamlTask?.execution ? { execution: yamlTask.execution } : {}),
        ...(yamlTask?.contextQueries ? { contextQueries: yamlTask.contextQueries } : {}),
        ...(yamlTask?.orchestrator ? { orchestrator: yamlTask.orchestrator } : {}),
      }
    : undefined;

  const config = resolveEffectiveConfig(definition, agentRow, taskOverrides);

  // Load myco.yaml for provider overrides (global, per-task, per-phase)
  let taskProviderOverride: ProviderConfig | undefined;
  let phaseProviderOverrides: Record<string, { provider?: ProviderConfig; maxTurns?: number }> = {};
  try {
    const mycoConfig = loadConfig(vaultDir);

    // Per-task override takes priority over global
    const taskConfig = taskName ? mycoConfig.agent.tasks?.[taskName] : undefined;
    const globalProvider = mycoConfig.agent.provider;

    if (taskConfig?.provider) {
      taskProviderOverride = toProviderConfig(taskConfig.provider);
    } else if (globalProvider) {
      taskProviderOverride = toProviderConfig(globalProvider);
    }

    // Per-phase overrides from myco.yaml
    if (taskConfig?.phases) {
      for (const [phaseName, phaseConfig] of Object.entries(taskConfig.phases)) {
        phaseProviderOverrides[phaseName] = {
          ...(phaseConfig.provider ? { provider: toProviderConfig(phaseConfig.provider) } : {}),
          ...(phaseConfig.maxTurns != null ? { maxTurns: phaseConfig.maxTurns } : {}),
        };
      }
    }
  } catch {
    // Config load failure is non-fatal — proceed without overrides
  }

  return {
    config,
    definitionsDir,
    taskProviderOverride,
    phaseProviderOverrides,
    taskName,
  };
}
