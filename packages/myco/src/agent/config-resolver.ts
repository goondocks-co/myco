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
import { loadMergedConfig } from '@myco/config/loader.js';
import type { MycoConfig, PhaseOverride, TaskProviderOverride } from '@myco/config/schema.js';
import type { ProviderConfig, EffectiveConfig, HarnessId } from './types.js';
import { HARNESS_CLAUDE_SDK } from './types.js';
import { inferHarnessFromProviderType } from './provider-harness.js';

/**
 * Returns true when an agent provider is configured for the given task —
 * either via a per-task override (`agent.tasks[name].provider`) or the
 * global default (`agent.provider`). Per-task overrides take precedence,
 * matching the resolution order in `resolveRunConfig` below.
 */
export function hasConfiguredProvider(mycoConfig: MycoConfig, taskName?: string): boolean {
  const taskProvider = taskName ? mycoConfig.agent.tasks?.[taskName]?.provider : undefined;
  return !!(taskProvider ?? mycoConfig.agent.provider);
}

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
  /** Per-phase provider/model/maxTurns overrides from myco.yaml. */
  phaseProviderOverrides: Record<string, { provider?: ProviderConfig; model?: string; maxTurns?: number }>;
  /** Effective task name (from DB or options). */
  taskName?: string;
  /** Resolved task params — YAML defaults merged with myco.yaml overrides. */
  taskParams?: Record<string, string | number | boolean>;
  /** Effective harness after applying YAML + myco.yaml overrides. */
  harness: HarnessId;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a myco.yaml snake_case provider to the harness camelCase ProviderConfig.
 *
 * API keys are NOT stored in myco.yaml — they flow via env vars
 * (settings.json -> hooks -> daemon).
 */
function toProviderConfig(p: {
  type: 'anthropic' | 'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'openai-compatible';
  local_backend?: 'ollama' | 'lmstudio';
  base_url?: string;
  model?: string;
  reasoning_map?: Partial<Record<'low' | 'default' | 'high', string>>;
  context_length?: number;
}): ProviderConfig {
  return {
    type: p.type,
    localBackend: p.local_backend,
    baseUrl: p.base_url,
    model: p.model,
    reasoningMap: p.reasoning_map,
    contextLength: p.context_length,
  };
}

function applyTaskConfigOverrides(
  config: EffectiveConfig,
  taskConfig: TaskProviderOverride | undefined,
  harness: HarnessId,
): EffectiveConfig {
  const reasoningLevel = taskConfig?.reasoningLevel;
  return {
    ...config,
    harness,
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(reasoningLevel && config.execution
      ? { execution: { ...config.execution, reasoningLevel } }
      : {}),
    ...(taskConfig?.model ? { model: taskConfig.model } : {}),
    ...(taskConfig?.maxTurns ? { maxTurns: taskConfig.maxTurns } : {}),
    ...(taskConfig?.timeoutSeconds ? { timeoutSeconds: taskConfig.timeoutSeconds } : {}),
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
 * @param groveId — Grove id from the request context; null when confirmed
 *   no Grove is bound; undefined triggers a dev-mode warning.
 * @returns the fully resolved config bundle.
 */
export function resolveRunConfig(
  agentId: string,
  requestedTask: string | undefined,
  vaultDir: string,
  groveId?: string | null,
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
        ...(yamlTask?.reasoningLevel ? { reasoningLevel: yamlTask.reasoningLevel } : {}),
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
  let taskConfig: TaskProviderOverride | undefined;
  let phaseProviderOverrides: Record<string, { provider?: ProviderConfig; model?: string; maxTurns?: number }> = {};
  let taskParams: Record<string, string | number | boolean> | undefined;
  let harness: HarnessId = config.execution?.harness
    ?? HARNESS_CLAUDE_SDK;
  try {
    const mycoConfig = loadMergedConfig(vaultDir, { groveId });

    // Per-task override takes priority over global
    taskConfig = taskName ? mycoConfig.agent.tasks?.[taskName] : undefined;
    const globalProvider = mycoConfig.agent.provider;
    harness = taskConfig?.harness
      ?? inferHarnessFromProviderType(taskConfig?.provider?.type)
      ?? mycoConfig.agent.harness
      ?? inferHarnessFromProviderType(globalProvider?.type)
      ?? config.execution?.harness
      ?? inferHarnessFromProviderType(config.execution?.provider?.type)
      ?? HARNESS_CLAUDE_SDK;

    if (taskConfig?.provider) {
      taskProviderOverride = toProviderConfig(taskConfig.provider);
    } else if (globalProvider) {
      taskProviderOverride = toProviderConfig(globalProvider);
    }

    // Per-phase overrides from myco.yaml
    if (taskConfig?.phases) {
      for (const [phaseName, phaseConfig] of Object.entries(taskConfig.phases) as Array<[string, PhaseOverride]>) {
        phaseProviderOverrides[phaseName] = {
          ...(phaseConfig.provider ? { provider: toProviderConfig(phaseConfig.provider) } : {}),
          ...(phaseConfig.model != null ? { model: phaseConfig.model } : {}),
          ...(phaseConfig.maxTurns != null ? { maxTurns: phaseConfig.maxTurns } : {}),
        };
      }
    }

    // Resolve task params: YAML defaults merged with myco.yaml overrides
    const yamlParams = yamlTask?.params;
    const configParams = taskConfig?.params;
    if (yamlParams || configParams) {
      taskParams = { ...yamlParams, ...configParams };
    }
  } catch (err) {
    // Config load failure is non-fatal — proceed without overrides — but
    // surface it so a malformed myco.yaml doesn't silently fall back to the
    // default harness with no signal.
    console.warn(
      `[agent] Failed to load myco.yaml overrides for run resolution: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    config: applyTaskConfigOverrides(config, taskConfig, harness),
    definitionsDir,
    taskProviderOverride,
    phaseProviderOverrides,
    taskName,
    taskParams,
    harness,
  };
}
