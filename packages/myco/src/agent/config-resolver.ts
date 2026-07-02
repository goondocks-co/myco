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
import type { ProviderConfig, EffectiveConfig, HarnessId, ReasoningLevel } from './types.js';
import { HARNESS_CLAUDE_SDK } from './types.js';
import { inferHarnessFromProviderType } from './provider-harness.js';
import type { AgentTask } from './types.js';

/**
 * Returns true when an agent provider is configured for the given task —
 * either via a per-task override (`agent.tasks[name].provider`) or the
 * global default (`agent.provider`). Per-task overrides take precedence,
 * matching the resolution order in `resolveRunConfig` below.
 */
type ProviderType = Parameters<typeof inferHarnessFromProviderType>[0];

/**
 * Single source of truth for the effective harness from the layered config.
 * Both the executor (`resolveRunConfig`) and the manual-run admission guard
 * (`hasConfiguredProvider`) resolve through this so they cannot drift — the
 * exact "guard admits a run the executor can't run" gap this guards against.
 *
 * Precedence (highest first): per-task myco.yaml harness → its provider type →
 * global myco.yaml harness → its provider type → the task definition's harness →
 * its provider type → the claude-sdk default.
 */
export function resolveEffectiveHarness(opts: {
  taskHarness?: HarnessId;
  taskProviderType?: ProviderType;
  globalHarness?: HarnessId;
  globalProviderType?: ProviderType;
  definitionHarness?: HarnessId;
  definitionProviderType?: ProviderType;
}): HarnessId {
  return opts.taskHarness
    ?? inferHarnessFromProviderType(opts.taskProviderType)
    ?? opts.globalHarness
    ?? inferHarnessFromProviderType(opts.globalProviderType)
    ?? opts.definitionHarness
    ?? inferHarnessFromProviderType(opts.definitionProviderType)
    ?? HARNESS_CLAUDE_SDK;
}

/**
 * The task definition's intrinsic execution harness/provider (from the YAML task
 * registry merged with user vault tasks). The manual-run admission guard needs
 * it to match the executor's harness resolution; `resolveRunConfig` reads the
 * same `config.execution` itself.
 */
export function resolveTaskDefinitionExecution(
  taskName: string | undefined,
  vaultDir: string,
): { harness?: HarnessId; providerType?: ProviderType } {
  if (!taskName) return {};
  const execution = loadAllTasks(resolveDefinitionsDir(), vaultDir).get(taskName)?.execution;
  return { harness: execution?.harness, providerType: execution?.provider?.type };
}

/**
 * Whether an agent run may proceed under `mycoConfig`.
 *
 * Strict by default: an explicit provider (per-task or global) must be set.
 * Automatic runs (e.g. Cortex per-grove) use the strict form so a grove with no
 * provider is not silently auto-run.
 *
 * `allowDefaultHarness` is for USER-INITIATED manual runs (POST /api/agent/run):
 * there, no explicit provider is fine when the effective harness is the default
 * claude-sdk, which shells out to the Claude Code CLI (subscription auth) and
 * needs no provider config. claude-sdk self-validates the CLI at run time with a
 * clear, actionable error if it is absent. A non-claude harness (incl. one
 * pinned by the task definition — pass it via `definitionHarness`/
 * `definitionProviderType`) with no provider genuinely cannot run and is still
 * blocked, so the guard never admits a run the executor would reject.
 */
export function hasConfiguredProvider(
  mycoConfig: MycoConfig,
  taskName?: string,
  opts?: { allowDefaultHarness?: boolean; definitionHarness?: HarnessId; definitionProviderType?: ProviderType },
): boolean {
  const taskConfig = taskName ? mycoConfig.agent.tasks?.[taskName] : undefined;
  if (taskConfig?.provider ?? mycoConfig.agent.provider) return true;
  if (!opts?.allowDefaultHarness) return false;
  const harness = resolveEffectiveHarness({
    taskHarness: taskConfig?.harness,
    globalHarness: mycoConfig.agent.harness,
    definitionHarness: opts.definitionHarness,
    definitionProviderType: opts.definitionProviderType,
  });
  return harness === HARNESS_CLAUDE_SDK;
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
  /**
   * Merged agent.semantic_write_check_enabled value from myco.yaml, used
   * ONLY as the default for a run's FIRST dispatch (see executor.ts). A
   * resumed run must never re-read this — it reads the snapshotted value
   * from agent_runs.execution_overrides instead. Lives here (not on
   * EffectiveConfig) because EffectiveConfig is a per-task-execution shape
   * (harness/model/phases/tools), not a mirror of agent.* config.
   */
  semanticWriteCheckEnabledDefault: boolean;
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
  thinking_budget_map?: Partial<Record<'low' | 'default' | 'high', { budgetTokens: number } | { adaptive: true }>>;
  effort_map?: Partial<Record<'low' | 'default' | 'high', { effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; verbosity?: 'low' | 'medium' | 'high' }>>;
  context_length?: number;
}): ProviderConfig {
  return {
    type: p.type,
    localBackend: p.local_backend,
    baseUrl: p.base_url,
    model: p.model,
    reasoningMap: p.reasoning_map,
    thinkingBudgetMap: p.thinking_budget_map,
    effortMap: p.effort_map,
    contextLength: p.context_length,
  };
}

function taskOverridesFromSources(
  taskRow: ReturnType<typeof getTask> | ReturnType<typeof getDefaultTask>,
  yamlTask: AgentTask | undefined,
): AgentTask | undefined {
  if (!taskRow && !yamlTask) return undefined;

  const name = taskRow?.id ?? yamlTask?.name;
  if (!name) return undefined;

  return {
    name,
    displayName: taskRow?.display_name ?? yamlTask?.displayName ?? name,
    description: taskRow?.description ?? yamlTask?.description ?? '',
    agent: taskRow?.agent_id ?? yamlTask?.agent ?? '',
    prompt: taskRow?.prompt ?? yamlTask?.prompt ?? '',
    isDefault: taskRow ? taskRow.is_default === 1 : (yamlTask?.isDefault ?? false),
    ...(taskRow?.tool_overrides
      ? { toolOverrides: JSON.parse(taskRow.tool_overrides) as string[] }
      : yamlTask?.toolOverrides
        ? { toolOverrides: yamlTask.toolOverrides }
        : {}),
    ...(yamlTask?.model ? { model: yamlTask.model } : {}),
    ...(yamlTask?.reasoningLevel ? { reasoningLevel: yamlTask.reasoningLevel } : {}),
    ...(yamlTask?.maxTurns ? { maxTurns: yamlTask.maxTurns } : {}),
    ...(yamlTask?.timeoutSeconds ? { timeoutSeconds: yamlTask.timeoutSeconds } : {}),
    ...(yamlTask?.phases ? { phases: yamlTask.phases } : {}),
    ...(yamlTask?.execution ? { execution: yamlTask.execution } : {}),
    ...(yamlTask?.contextQueries ? { contextQueries: yamlTask.contextQueries } : {}),
    ...(yamlTask?.orchestrator ? { orchestrator: yamlTask.orchestrator } : {}),
  };
}

/**
 * Apply the myco.yaml task-config overrides on top of the resolved effective
 * config. Reasoning-tier precedence (highest first):
 *   1. per-task override — `agent.tasks[name].reasoningLevel`
 *   2. task's own level  — the task definition's intrinsic `reasoningLevel`
 *   3. grove default     — `agent.reasoningLevel`
 *   4. (unset → the executor's built-in `default` tier)
 * The `execution.reasoningLevel` mirror is rewritten only for the per-task
 * override, preserving the task definition's own execution block otherwise.
 *
 * Exported for unit tests that lock this precedence.
 */
export function applyTaskConfigOverrides(
  config: EffectiveConfig,
  taskConfig: TaskProviderOverride | undefined,
  harness: HarnessId,
  defaultReasoningLevel?: ReasoningLevel,
): EffectiveConfig {
  const overrideReasoning = taskConfig?.reasoningLevel;
  const reasoningLevel = overrideReasoning ?? config.reasoningLevel ?? defaultReasoningLevel;
  return {
    ...config,
    harness,
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(overrideReasoning && config.execution
      ? { execution: { ...config.execution, reasoningLevel: overrideReasoning } }
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

  const taskOverrides = taskOverridesFromSources(taskRow, yamlTask);

  const config = resolveEffectiveConfig(definition, agentRow, taskOverrides);

  // Load myco.yaml for provider overrides (global, per-task, per-phase)
  let taskProviderOverride: ProviderConfig | undefined;
  let taskConfig: TaskProviderOverride | undefined;
  let phaseProviderOverrides: Record<string, { provider?: ProviderConfig; model?: string; maxTurns?: number }> = {};
  let taskParams: Record<string, string | number | boolean> | undefined;
  let harness: HarnessId = config.execution?.harness
    ?? HARNESS_CLAUDE_SDK;
  // Grove-wide default reasoning tier — applied below when neither the
  // per-task override nor the task definition sets one.
  let defaultReasoningLevel: ReasoningLevel | undefined;
  let semanticWriteCheckEnabledDefault = false;
  try {
    const mycoConfig = loadMergedConfig(vaultDir, { groveId });

    // Per-task override takes priority over global
    taskConfig = taskName ? mycoConfig.agent.tasks?.[taskName] : undefined;
    defaultReasoningLevel = mycoConfig.agent.reasoningLevel;
    semanticWriteCheckEnabledDefault = mycoConfig.agent.semantic_write_check_enabled ?? false;
    const globalProvider = mycoConfig.agent.provider;
    harness = resolveEffectiveHarness({
      taskHarness: taskConfig?.harness,
      taskProviderType: taskConfig?.provider?.type,
      globalHarness: mycoConfig.agent.harness,
      globalProviderType: globalProvider?.type,
      definitionHarness: config.execution?.harness,
      definitionProviderType: config.execution?.provider?.type,
    });

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
    config: applyTaskConfigOverrides(config, taskConfig, harness, defaultReasoningLevel),
    definitionsDir,
    taskProviderOverride,
    phaseProviderOverrides,
    taskName,
    taskParams,
    harness,
    semanticWriteCheckEnabledDefault,
  };
}
