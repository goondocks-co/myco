/** Agent executor — orchestrates a single agent run end to end. */

import crypto from 'node:crypto';
import { resolve } from 'node:path';
import {
  epochSeconds,
  DEFAULT_AGENT_ID,
  MS_PER_SECOND,
  PHASE_SUMMARY_MAX_CHARS,
  CONTENT_HASH_ALGORITHM,
} from '@myco/constants.js';
import { errorMessage as toErrorMessage } from '@myco/utils/error-message.js';
import { tryParseJson } from '@myco/utils/json.js';
import { initDatabase, vaultDbPath } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import { listReports } from '@myco/db/queries/reports.js';
import { getDefaultTask } from '@myco/db/queries/tasks.js';
import {
  insertRun,
  updateRunStatus,
  updateRun,
  applyRunUpdate,
  getRun,
  getRunningRunForTask,
  RESUME_STATUS_READY,
  STATUS_RUNNING,
  STATUS_COMPLETED,
  STATUS_FAILED,
} from '@myco/db/queries/runs.js';
import { loadSystemPrompt } from './loader.js';
import { buildVaultContext } from './context.js';
import { composeOrchestratorPrompt, parseOrchestratorPlan, applyDirectives, DEFAULT_ORCHESTRATOR_MAX_TURNS } from './orchestrator.js';
import { executeContextQueries } from './context-queries.js';
import { resolveRunConfig } from './config-resolver.js';
import { resolveOllamaContextVariants } from './ollama-context.js';
import { resolveReasoningModel } from './reasoning-levels.js';
import { validateTaskPostconditions } from './task-postconditions.js';
import { computeWaves, phaseSessionId } from './wave-computation.js';
import { CORTEX_INSTRUCTIONS_TASK, SKILL_GENERATE_TASK } from './instruction-builders.js';
import { resolveCost } from './cost/index.js';
import {
  aggregateUsage,
  abortReasonMessage,
  buildUsageData,
  checkpointResultsForResume,
  isSessionResumeFailure,
  parseCheckpointState,
  resolveProviderForResume,
  serializeCheckpointState,
  type RunCheckpointState,
} from './executor-state.js';
import {
  analyzeRuntimeTokenBudget,
  buildRunAccountingUpdate,
  summarizePhaseCosts,
} from './run-accounting.js';
import { getAgentRuntime } from './runtime/index.js';
import type { CostResolution } from './cost/types.js';
import type { ContextQueryResult } from './context-queries.js';
import type { ProviderConfig } from './types.js';
import type {
  RunOptions,
  AgentRunResult,
  EffectiveConfig,
  PhaseDefinition,
  PhaseResult,
  ReasoningLevel,
  RuntimeUsage,
} from './types.js';

// Re-export computeWaves for backward compatibility (tests import from executor)
export { computeWaves } from './wave-computation.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Run status returned when a concurrent run is already active. */
const STATUS_SKIPPED = 'skipped';

/** Reason string when skipping due to concurrency guard. */
const SKIP_REASON_ALREADY_RUNNING = 'already_running';

/** Section header for vault context in the composed prompt. */
const PROMPT_SECTION_TASK = '## Task: ';

/** Section header for user instruction in the composed prompt. */
const PROMPT_SECTION_INSTRUCTION = '## User Instruction';

/** Report action emitted by the Cortex instructions task. */
const CORTEX_INSTRUCTIONS_REPORT_ACTION = 'cortex_instructions';

/** Details key storing the final markdown content in the Cortex report. */
const CORTEX_INSTRUCTIONS_CONTENT_KEY = 'content';

/** Separator between prompt sections. */
const PROMPT_SECTION_SEPARATOR = '\n\n';

/** Header for prior phase context in phased prompts. */
const PROMPT_SECTION_PRIOR_PHASES = '## Prior Phase Results';

/** Header for the current phase in phased prompts. */
const PROMPT_SECTION_CURRENT_PHASE = '## Current Phase: ';
const TOKEN_BUDGET_PRESSURE_STATUSES = new Set(['warning', 'critical']);

function logTokenBudgetPressure(
  taskName: string,
  usage: RuntimeUsage,
  provider?: ProviderConfig,
): void {
  const budget = analyzeRuntimeTokenBudget(usage, provider);
  if (!TOKEN_BUDGET_PRESSURE_STATUSES.has(budget.status)) return;
  console.warn(
    `[agent] ${taskName} token budget ${budget.status}: ` +
    `${budget.utilizationPercent}% of ${budget.contextWindowTokens} tokens ` +
    `at peak request (${budget.peakRequestTotalTokens} tokens)`,
  );
}

/**
 * myco.yaml-sourced per-phase provider / model / maxTurns overrides, keyed
 * by phase name. Passed through `resolveRunConfig` alongside the
 * task-level provider override.
 */
export interface MycoYamlPhaseOverrides {
  [phaseName: string]: {
    provider?: ProviderConfig;
    model?: string;
    maxTurns?: number;
  };
}

/**
 * Compute the effective `{ reasoningLevel, model, provider, maxTurns }` for
 * a single phase by reconciling all layered sources. Extracted for
 * unit-testability — the wave loop calls this helper directly.
 *
 * Provider precedence (highest → lowest):
 *   1. `options.executionOverrides.phases[name].provider` — run override
 *   2. `phase.provider` — task YAML
 *   3. `phaseProviderOverrides[name].provider` — myco.yaml per-phase override
 *   4. `options.executionOverrides.provider` — top-level run override
 *   5. `provider` parameter — task default / task override from myco.yaml
 *
 * Model precedence (highest → lowest):
 *   1. `options.executionOverrides.phases[name].model`
 *   2. `phaseProviderOverrides[name].model` (myco.yaml)
 *   3. `resolveReasoningModel(effectiveReasoning, provider, fallback)`
 *      where `fallback = phase.model ?? options.executionOverrides.model
 *      ?? config.model`
 *
 * Reasoning precedence (highest → lowest):
 *   1. `options.executionOverrides.phases[name].reasoningLevel`
 *   2. `phase.reasoningLevel` (task YAML)
 *   3. `options.executionOverrides.reasoningLevel`
 *   4. `config.execution.reasoningLevel`
 *   5. `config.reasoningLevel`
 *
 * maxTurns precedence (highest → lowest):
 *   1. `options.executionOverrides.phases[name].maxTurns`
 *   2. `phaseProviderOverrides[name].maxTurns` (myco.yaml)
 *   3. `phase.maxTurns` (task YAML)
 */
export function resolvePhaseExecution(
  phase: PhaseDefinition,
  options: RunOptions | undefined,
  config: EffectiveConfig,
  provider: ProviderConfig | undefined,
  phaseProviderOverrides?: MycoYamlPhaseOverrides,
): { reasoningLevel: ReasoningLevel | undefined; model: string; maxTurns: number; provider: ProviderConfig | undefined } {
  const runPhaseOverride = options?.executionOverrides?.phases?.[phase.name];
  const topOverride = options?.executionOverrides;
  const mycoYamlPhase = phaseProviderOverrides?.[phase.name];

  const effectiveProvider: ProviderConfig | undefined =
    runPhaseOverride?.provider
    ?? phase.provider
    ?? mycoYamlPhase?.provider
    ?? topOverride?.provider
    ?? provider;

  const effectiveReasoning: ReasoningLevel | undefined =
    runPhaseOverride?.reasoningLevel
    ?? phase.reasoningLevel
    ?? topOverride?.reasoningLevel
    ?? config.execution?.reasoningLevel
    ?? config.reasoningLevel;

  const fallbackModel =
    phase.model
    ?? topOverride?.model
    ?? config.model;

  const effectiveModel =
    runPhaseOverride?.model
    ?? mycoYamlPhase?.model
    ?? resolveReasoningModel(effectiveReasoning, effectiveProvider, fallbackModel);

  const effectiveMaxTurns =
    runPhaseOverride?.maxTurns
    ?? mycoYamlPhase?.maxTurns
    ?? phase.maxTurns;

  return {
    reasoningLevel: effectiveReasoning,
    model: effectiveModel,
    maxTurns: effectiveMaxTurns,
    provider: effectiveProvider,
  };
}

/**
 * Warn once per run when `executionOverrides.phases` contains keys that do
 * not match any phase in the task. The warning lists the unknown keys and
 * the task's actual phase names so callers can correct their payload.
 */
function warnUnknownPhaseOverrides(
  options: RunOptions | undefined,
  taskPhases: readonly PhaseDefinition[] | undefined,
): void {
  const overridePhases = options?.executionOverrides?.phases;
  if (!overridePhases) return;
  const keys = Object.keys(overridePhases);
  if (keys.length === 0) return;
  const known = new Set((taskPhases ?? []).map((p) => p.name));
  const unknown = keys.filter((k) => !known.has(k));
  if (unknown.length === 0) return;
  const taskPhaseNames = (taskPhases ?? []).map((p) => p.name);
  console.warn(
    `[agent] Unknown phase override keys: ${unknown.join(', ')} ` +
    `(task phases: ${taskPhaseNames.join(', ') || '<none>'})`,
  );
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

/**
 * Build the full task prompt from vault context, task definition, and
 * optional user instruction.
 *
 * Task prompts support template variables:
 * - `{{session_id}}` — replaced with the session ID from instruction (if present)
 * - `{{instruction}}` — the raw user instruction text
 */
export function composeTaskPrompt(
  vaultContext: string,
  taskDisplayName: string,
  taskPrompt: string,
  instruction?: string,
): string {
  // Extract session_id from instruction if it contains one (UUID pattern)
  const sessionIdMatch = instruction?.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  const sessionId = sessionIdMatch?.[1] ?? '';

  // Template variable substitution in task prompt
  let resolvedPrompt = taskPrompt;
  resolvedPrompt = resolvedPrompt.replace(/\{\{session_id\}\}/g, sessionId);
  resolvedPrompt = resolvedPrompt.replace(/\{\{instruction\}\}/g, instruction ?? '');

  const parts = [
    vaultContext,
    `${PROMPT_SECTION_TASK}${taskDisplayName}\n${resolvedPrompt}`,
  ];

  if (instruction) {
    parts.push(`${PROMPT_SECTION_INSTRUCTION}\n${instruction}`);
  }

  return parts.join(PROMPT_SECTION_SEPARATOR);
}

/**
 * Build the prompt for a single phase in a phased execution.
 *
 * Includes vault context, the task overview, prior phase summaries,
 * and the current phase instructions.
 */
export function composePhasePrompt(
  vaultContext: string,
  taskDisplayName: string,
  taskOverview: string,
  phase: PhaseDefinition,
  priorPhaseResults: PhaseResult[],
  instruction?: string,
): string {
  const parts = [
    vaultContext,
    `${PROMPT_SECTION_TASK}${taskDisplayName}\n${taskOverview}`,
  ];

  if (instruction) {
    parts.push(`${PROMPT_SECTION_INSTRUCTION}\n${instruction}`);
  }

  // Include prior phase results as context (unless the phase opts out)
  if (priorPhaseResults.length > 0 && !phase.skipPriorContext) {
    const summaries = priorPhaseResults.map((pr) => {
      const truncated = pr.summary.length > PHASE_SUMMARY_MAX_CHARS
        ? pr.summary.slice(0, PHASE_SUMMARY_MAX_CHARS) + '...'
        : pr.summary;
      return `### ${pr.name} (${pr.status})\n${truncated}`;
    });
    parts.push(`${PROMPT_SECTION_PRIOR_PHASES}\n${summaries.join('\n\n')}`);
  }

  // Current phase instructions
  parts.push(`${PROMPT_SECTION_CURRENT_PHASE}${phase.name}\n${phase.prompt}`);

  return parts.join(PROMPT_SECTION_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Single-phase execution helper
// ---------------------------------------------------------------------------

/**
 * Execute a single phase query through the selected runtime adapter.
 */
async function executePhase(
  config: EffectiveConfig,
  phasePrompt: string,
  phaseModel: string,
  systemPrompt: string,
  phase: PhaseDefinition,
  toolSurface: {
    agentId: string;
    runId: string;
    toolNames: string[];
    turnOffset: number;
    projectRoot?: string;
    vaultDir?: string;
    readOnly?: boolean;
    embeddingManager?: RunOptions['embeddingManager'];
    dryRun?: boolean;
  },
  provider?: ProviderConfig,
  sessionId?: string,
  sessionData?: unknown,
  abortController?: AbortController,
): Promise<PhaseResult & { sessionData?: unknown }> {
  const runtime = getAgentRuntime(config.runtime);
  try {
    let result;
    try {
      result = await runtime.execute({
        prompt: phasePrompt,
        model: phaseModel,
        maxTurns: phase.maxTurns,
        systemPrompt,
        provider,
        sessionRef: sessionId,
        sessionData,
        abortController,
        toolSurface,
      });
    } catch (error) {
      if (!sessionId || !runtime.supports('supportsSessionResume') || !isSessionResumeFailure(error)) {
        throw error;
      }
      console.warn(`[agent] Resuming phase "${phase.name}" session failed, retrying without prior session`);
      result = await runtime.execute({
        prompt: phasePrompt,
        model: phaseModel,
        maxTurns: phase.maxTurns,
        systemPrompt,
        provider,
        abortController,
        toolSurface,
      });
    }

    if (phase.maxTurns && result.turnsUsed > 0) {
      console.log(`[agent] Phase "${phase.name}": num_turns=${result.turnsUsed}, budget=${phase.maxTurns}`);
    }

    if (phase.required && result.turnsUsed === 0) {
      console.warn(`[agent] Required phase "${phase.name}" produced 0 turns`);
    }

    const costData = await resolveCost({
      runtime: config.runtime,
      provider,
      model: phaseModel,
      usage: result.usage,
    });

    return {
      name: phase.name,
      status: 'completed',
      turnsUsed: result.turnsUsed,
      tokensUsed: result.usage.totalTokens ?? 0,
      costUsd: costData.costUsd ?? 0,
      costSource: costData.source,
      costData,
      summary: result.finalText,
      usage: result.usage,
      sessionRef: result.sessionRef,
      sessionData: result.sessionData,
    };
  } catch (err) {
    const abortReason = abortReasonMessage(abortController);
    return {
      name: phase.name,
      status: 'failed',
      turnsUsed: 0,
      tokensUsed: 0,
      costUsd: 0,
      summary: abortReason ? `Error: ${abortReason}` : `Error: ${toErrorMessage(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Single-query execution (non-phased tasks)
// ---------------------------------------------------------------------------

/**
 * Execute a single query() call for non-phased tasks.
 *
 * @returns tokens used, cost, and status.
 */
async function executeSingleQuery(
  config: EffectiveConfig,
  systemPrompt: string,
  taskPrompt: string,
  agentId: string,
  runId: string,
  provider?: ProviderConfig,
  embeddingManager?: RunOptions['embeddingManager'],
  abortController?: AbortController,
  vaultDir?: string,
  sessionRef?: string,
  sessionData?: unknown,
): Promise<{ tokensUsed: number; costUsd: number | null; costData: CostResolution; usage: RuntimeUsage; sessionRef?: string; sessionData?: unknown }> {
  const runtime = getAgentRuntime(config.runtime);
  const effectiveModel = resolveReasoningModel(
    config.execution?.reasoningLevel ?? config.reasoningLevel,
    provider,
    config.model,
  );
  const result = await runtime.execute({
    prompt: taskPrompt,
    model: effectiveModel,
    maxTurns: config.maxTurns,
    systemPrompt,
    provider,
    abortController,
    sessionRef,
    sessionData,
    toolSurface: {
      agentId,
      runId,
      vaultDir,
      embeddingManager,
      dryRun: config.dryRun ?? false,
    },
  });
  const costData = await resolveCost({
    runtime: config.runtime,
    provider,
    model: effectiveModel,
    usage: result.usage,
  });

  return {
    tokensUsed: result.usage.totalTokens ?? 0,
    costUsd: costData.costUsd,
    costData,
    usage: result.usage,
    sessionRef: result.sessionRef,
    sessionData: result.sessionData,
  };
}

// ---------------------------------------------------------------------------
// Phased execution (wave-based parallel)
// ---------------------------------------------------------------------------

/**
 * Execute a phased task — wave-based parallel query() calls.
 *
 * Phases are sorted into waves via `computeWaves()`. Phases within the same
 * wave execute concurrently via `Promise.allSettled()`. Each phase gets:
 * - Scoped tools (only the tools listed in the phase definition)
 * - Its own turn budget (maxTurns)
 * - Optional model override (falls back to task/agent model)
 * - Isolated provider env (via SDK `env` option — no process.env mutation)
 * - Context from prior wave results
 * - Deterministic session ID derived from run ID + phase name
 *
 * The executor controls the loop — the LLM cannot skip phases.
 */
async function executePhasedQuery(
  config: EffectiveConfig,
  systemPrompt: string,
  vaultContext: string,
  agentId: string,
  runId: string,
  taskProviderOverride?: ProviderConfig,
  phaseProviderOverrides?: Record<string, { provider?: ProviderConfig; model?: string; maxTurns?: number }>,
  instruction?: string,
  embeddingManager?: RunOptions['embeddingManager'],
  abortController?: AbortController,
  projectRoot?: string,
  vaultDir?: string,
  checkpointState?: RunCheckpointState,
  persistCheckpoints?: (state: RunCheckpointState, phases: PhaseResult[]) => Promise<void>,
  options?: RunOptions,
): Promise<{ tokensUsed: number; costUsd: number | null; costData: CostResolution; usage: RuntimeUsage; phases: PhaseResult[] }> {
  const phases = config.phases!;
  const state = checkpointState ?? {
    runtime: config.runtime,
    provider: taskProviderOverride?.type ?? config.execution?.provider?.type,
    model: resolveReasoningModel(
      config.execution?.reasoningLevel ?? config.reasoningLevel,
      taskProviderOverride ?? config.execution?.provider,
      config.model,
    ),
    phases: {},
  };
  const phaseResults: PhaseResult[] = checkpointResultsForResume(config, state);
  let runningTurnCount = phaseResults.reduce((sum, phase) => sum + phase.turnsUsed, 0);
  const completedPhaseNames = new Set(phaseResults.map((phase) => phase.name));

  // ---------------------------------------------------------------------------
  // Orchestrator planning (opt-in via config.orchestrator.enabled)
  // ---------------------------------------------------------------------------

  let effectivePhases = [...phases];

  if (config.orchestrator?.enabled) {
    const contextQueries = config.contextQueries
      ? Object.values(config.contextQueries).flat()
      : [];
    const contextResults: ContextQueryResult[] = contextQueries.length > 0
      ? await executeContextQueries(agentId, contextQueries)
      : [];

    const orchestratorPrompt = composeOrchestratorPrompt(vaultContext, phases, contextResults);
    const orchestratorModel = config.orchestrator.model ?? resolveReasoningModel(
      config.orchestrator.reasoningLevel ?? config.execution?.reasoningLevel ?? config.reasoningLevel,
      taskProviderOverride ?? config.execution?.provider,
      config.model,
    );
    const orchestratorMaxTurns = config.orchestrator.maxTurns ?? DEFAULT_ORCHESTRATOR_MAX_TURNS;
    const runtime = getAgentRuntime(config.runtime);
    const planResponse = await runtime.execute({
      prompt: orchestratorPrompt,
      model: orchestratorModel,
      maxTurns: orchestratorMaxTurns,
      systemPrompt,
      provider: taskProviderOverride ?? config.execution?.provider,
      toolSurface: {
        agentId,
        runId,
        toolNames: [],
        vaultDir,
        dryRun: config.dryRun ?? false,
      },
      abortController,
    });

    const plan = parseOrchestratorPlan(planResponse.finalText, phases);
    effectivePhases = applyDirectives(phases, plan.phases);
  }

  // ---------------------------------------------------------------------------
  // Wave-based phase execution
  // ---------------------------------------------------------------------------

  // Build a map from phase name to its YAML declaration order for stable output
  const declarationOrder = new Map(phases.map((p, i) => [p.name, i]));

  const waves = computeWaves(effectivePhases);

  for (const wave of waves) {
    const runnableWave = wave.filter((phase) => !completedPhaseNames.has(phase.name));
    if (runnableWave.length === 0) {
      continue;
    }

    const waveInputs = runnableWave.map((phase, indexInWave) => {
      const phasePrompt = composePhasePrompt(
        vaultContext,
        config.taskDisplayName,
        config.taskPrompt,
        phase,
        phaseResults,
        instruction,
      );

      // Single canonical precedence resolution — covers run overrides,
      // phase YAML, myco.yaml per-phase overrides, top-level run override,
      // and the task default. See `resolvePhaseExecution` JSDoc for the
      // full precedence table.
      const resolved = resolvePhaseExecution(
        phase,
        options,
        config,
        taskProviderOverride ?? config.execution?.provider,
        phaseProviderOverrides,
      );
      const phaseProvider = resolved.provider;
      const effectiveMaxTurns = resolved.maxTurns;
      const phaseModel = resolved.model;
      const existingCheckpoint = state.phases[phase.name];
      const sessionId = existingCheckpoint?.sessionRef ?? phaseSessionId(runId, phase.name);
      const effectivePhase = effectiveMaxTurns !== phase.maxTurns
        ? { ...phase, maxTurns: effectiveMaxTurns }
        : phase;

      state.phases[phase.name] = {
        name: phase.name,
        status: 'running',
        summary: existingCheckpoint?.summary,
        turnsUsed: existingCheckpoint?.turnsUsed,
        tokensUsed: existingCheckpoint?.tokensUsed,
        costUsd: existingCheckpoint?.costUsd,
        costSource: existingCheckpoint?.costSource,
        costData: existingCheckpoint?.costData,
        sessionRef: sessionId,
        sessionData: existingCheckpoint?.sessionData,
        usage: existingCheckpoint?.usage,
        updatedAt: epochSeconds(),
      };

      return {
        phase,
        phasePrompt,
        phaseModel,
        phaseProvider,
        effectivePhase,
        sessionId,
        sessionData: existingCheckpoint?.sessionData,
        toolSurface: {
          agentId,
          runId,
          toolNames: phase.tools,
          turnOffset: runningTurnCount + (indexInWave * effectiveMaxTurns),
          projectRoot,
          vaultDir,
          readOnly: phase.readOnly,
          embeddingManager,
          dryRun: config.dryRun ?? false,
        },
      };
    });

    if (persistCheckpoints) {
      await persistCheckpoints(state, phaseResults);
    }

    const settled = await Promise.allSettled(
      waveInputs.map((input) =>
        executePhase(
          config,
          input.phasePrompt,
          input.phaseModel,
          systemPrompt,
          input.effectivePhase,
          input.toolSurface,
          input.phaseProvider,
          input.sessionId,
          input.sessionData,
          abortController,
        ),
      ),
    );

    const fulfilledByName = new Map<string, PhaseResult & { sessionData?: unknown }>();
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        fulfilledByName.set(runnableWave[index].name, outcome.value);
      }
    }

    // Map settled results to PhaseResult[]
    const waveResults: PhaseResult[] = settled.map((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        return outcome.value;
      }
      return {
        name: runnableWave[i].name,
        status: 'failed' as const,
        turnsUsed: 0,
        tokensUsed: 0,
        costUsd: 0,
        summary: `Error: ${toErrorMessage(outcome.reason)}`,
      };
    });

    // Sort by YAML declaration order for stable output
    waveResults.sort((a, b) =>
      (declarationOrder.get(a.name) ?? 0) - (declarationOrder.get(b.name) ?? 0),
    );

    for (const [index, result] of waveResults.entries()) {
      const priorCheckpoint = state.phases[result.name];
      const fulfilled = fulfilledByName.get(result.name) ?? null;
      state.phases[result.name] = {
        name: result.name,
        status: result.status === 'completed' ? 'completed' : 'failed',
        summary: result.summary,
        turnsUsed: result.turnsUsed,
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
        costSource: result.costSource,
        costData: result.costData,
        sessionRef: fulfilled?.sessionRef ?? priorCheckpoint?.sessionRef,
        sessionData: fulfilled?.sessionData ?? priorCheckpoint?.sessionData,
        usage: fulfilled?.usage ?? result.usage,
        updatedAt: epochSeconds(),
      };
      if (result.status === 'completed') {
        completedPhaseNames.add(result.name);
      }
      phaseResults.push(result);
      runningTurnCount += result.turnsUsed;
    }

    if (persistCheckpoints) {
      await persistCheckpoints(state, phaseResults);
    }

    // If any required phase in this wave failed, stop the pipeline
    const shouldStop = runnableWave.some((phase, i) => {
      if (!phase.required) return false;
      const outcome = settled[i];
      if (outcome.status === 'rejected') return true;
      return outcome.value.status === 'failed';
    });

    if (shouldStop) {
      break;
    }
  }

  const usage = aggregateUsage(phaseResults.map((phase) => phase.usage));
  const costData = summarizePhaseCosts(phaseResults);
  return {
    tokensUsed: usage.totalTokens ?? phaseResults.reduce((sum, phase) => sum + phase.tokensUsed, 0),
    costUsd: costData.costUsd,
    costData,
    usage,
    phases: phaseResults,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run an agent against a vault.
 *
 * For tasks with a `phases` array, uses wave-based parallel execution
 * (phases sorted into dependency waves via Kahn's algorithm). For tasks
 * without phases, uses a single query() call.
 *
 * @param vaultDir — absolute path to the vault directory.
 * @param options — optional overrides for agent, task, and instruction.
 * @returns the run result with status, token usage, and cost.
 */
export async function runAgent(
  vaultDir: string,
  options?: RunOptions,
): Promise<AgentRunResult> {
  const db = initDatabase(vaultDbPath(vaultDir));
  createSchema(db);

  const agentId = options?.agentId ?? DEFAULT_AGENT_ID;
  const resumedRun = options?.resumeRunId ? getRun(options.resumeRunId) : null;
  if (options?.resumeRunId && !resumedRun) {
    return {
      runId: options.resumeRunId,
      status: STATUS_FAILED,
      error: `Run ${options.resumeRunId} not found`,
    };
  }

  // Block duplicate runs of the SAME task — different tasks may run concurrently.
  const requestedTask = options?.task ?? resumedRun?.task ?? undefined;
  {
    const effectiveTask = requestedTask
      ?? getDefaultTask(agentId)?.id;
    if (effectiveTask) {
      const runningId = getRunningRunForTask(agentId, effectiveTask);
      if (runningId) {
        return {
          runId: runningId,
          status: STATUS_SKIPPED,
          reason: SKIP_REASON_ALREADY_RUNNING,
        };
      }
    }
  }

  const {
    config: resolvedConfig,
    definitionsDir,
    taskProviderOverride: resolvedTaskProvider,
    phaseProviderOverrides: resolvedPhaseOverrides,
  } = resolveRunConfig(agentId, requestedTask, vaultDir);

  // Build an effective config for this run by layering per-run overrides
  // on top of the resolved config WITHOUT mutating the resolveRunConfig
  // return value. Each cell in an evaluation matrix reuses the task's
  // resolved config and varies one or more of runtime / reasoning / model —
  // downstream code (provider selection, model routing, runtime dispatch)
  // reads from these fields, so we produce a fresh EffectiveConfig here.
  const overrideRuntime = options?.executionOverrides?.runtime;
  const overrideReasoning = options?.executionOverrides?.reasoningLevel;
  const overrideModel = options?.executionOverrides?.model;
  const config: EffectiveConfig = {
    ...resolvedConfig,
    dryRun: options?.dryRun ?? false,
    ...(overrideRuntime ? { runtime: overrideRuntime } : {}),
    ...(overrideReasoning ? { reasoningLevel: overrideReasoning } : {}),
    ...(overrideModel ? { model: overrideModel } : {}),
    ...(overrideReasoning && resolvedConfig.execution
      ? { execution: { ...resolvedConfig.execution, reasoningLevel: overrideReasoning } }
      : {}),
    ...(overrideModel && resolvedConfig.execution?.provider
      ? {
          execution: {
            ...(resolvedConfig.execution ?? {}),
            ...(overrideReasoning ? { reasoningLevel: overrideReasoning } : {}),
            provider: {
              ...resolvedConfig.execution.provider,
              model: overrideModel,
            },
          },
        }
      : {}),
  };

  // Emit a single run-startup warning (not per-phase) when the caller passed
  // `executionOverrides.phases` with keys that don't match this task's
  // phases — including the non-phased case, where any phases key is dead.
  warnUnknownPhaseOverrides(options, config.phases);

  // Both are mutated by the Ollama variant resolver below — it rewrites
  // provider.model to the variant name and may reconcile context conflicts.
  // If a top-level provider override was supplied via RunOptions, treat it as
  // the task-level provider for this run so phased + single-query paths see
  // it uniformly. Phase-level overrides still win at the phase boundary.
  let taskProviderOverride = options?.executionOverrides?.provider ?? resolvedTaskProvider;
  let phaseProviderOverrides = resolvedPhaseOverrides;

  const runId = options?.resumeRunId ?? crypto.randomUUID();
  const now = epochSeconds();
  let runtimeId = config.runtime;
  // Top-level provider override from RunOptions.executionOverrides wins over
  // both the myco.yaml task override AND the task YAML execution provider.
  // This lets an operator (RunTaskDialog / eval matrix) swap provider/base URL/
  // context length for a single run without modifying any persistent config.
  const baseProvider =
    options?.executionOverrides?.provider
    ?? taskProviderOverride
    ?? config.execution?.provider;
  let effectiveModel = resolveReasoningModel(
    config.execution?.reasoningLevel ?? config.reasoningLevel,
    baseProvider,
    config.model,
  );
  const checkpointState = resumedRun
    ? parseCheckpointState(resumedRun.checkpoints)
    : {
      runtime: runtimeId,
      provider: baseProvider?.type,
      providerConfig: baseProvider,
      model: effectiveModel,
      phases: {},
    };
  if (resumedRun) {
    runtimeId = resumedRun.runtime ?? checkpointState.runtime ?? runtimeId;
    effectiveModel = resumedRun.model ?? checkpointState.model ?? effectiveModel;
  }
  const effectiveProvider = resolveProviderForResume(
    baseProvider,
    resumedRun,
    checkpointState,
    runtimeId,
    effectiveModel,
  );
  if (!resumedRun) {
    checkpointState.runtime = runtimeId;
    checkpointState.provider = effectiveProvider?.type;
    checkpointState.providerConfig = effectiveProvider;
    checkpointState.model = effectiveModel;
  } else {
    checkpointState.runtime = checkpointState.runtime ?? runtimeId;
    checkpointState.provider = checkpointState.provider ?? effectiveProvider?.type;
    checkpointState.providerConfig = checkpointState.providerConfig ?? effectiveProvider;
    checkpointState.model = checkpointState.model ?? effectiveModel;
  }

  const runStart = {
    status: STATUS_RUNNING,
    runtime: runtimeId,
    model: effectiveModel,
    checkpoints: serializeCheckpointState(checkpointState),
    started_at: now,
  } as const;
  if (!resumedRun) {
    insertRun({
      id: runId,
      agent_id: agentId,
      task: config.taskName,
      instruction: options?.instruction ?? null,
      ...runStart,
      provider: effectiveProvider?.type ?? null,
      usage_data: buildUsageData({}),
      dryRun: options?.dryRun ?? false,
      evaluationId: options?.evaluationId ?? null,
      reasoningLevel:
        options?.executionOverrides?.reasoningLevel
        ?? config.reasoningLevel
        ?? config.execution?.reasoningLevel
        ?? null,
      executionOverrides: options?.executionOverrides ?? null,
    });
  } else {
    applyRunUpdate(runId, {
      ...runStart,
      provider: effectiveProvider?.type ?? resumedRun.provider ?? null,
      completed_at: null,
      resumable: 0,
      resume_status: null,
      resume_mode: options?.resumeMode ?? resumedRun.resume_mode ?? null,
      resumed_at: now,
      usage_data: resumedRun.usage_data,
      cost_usd: resumedRun.cost_usd,
      actual_cost_usd: resumedRun.actual_cost_usd,
      estimated_cost_usd: resumedRun.estimated_cost_usd,
      cost_source: resumedRun.cost_source,
      cost_data: resumedRun.cost_data,
      error: null,
    });
  }

  const systemPrompt = loadSystemPrompt(definitionsDir, config.systemPromptPath);
  const vaultContext = buildVaultContext(agentId);

  // Resolve Ollama context variants across task + phase scopes. Applies
  // DEFAULT_OLLAMA_CONTEXT_LENGTH when no value is set, and reconciles
  // same-model-different-context conflicts (max wins) so Ollama loads
  // each model at most once. Non-ollama providers pass through unchanged.
  {
    const resolved = await resolveOllamaContextVariants(
      taskProviderOverride,
      phaseProviderOverrides,
    );
    taskProviderOverride = resolved.taskProvider;
    phaseProviderOverrides = resolved.phaseOverrides;
    for (const conflict of resolved.conflicts) {
      console.warn(
        `[agent] Ollama model "${conflict.model}" referenced with conflicting ` +
        `context_length values [${conflict.values.join(', ')}] — reconciled to ` +
        `${conflict.resolved} to avoid loading multiple variants. Configure one ` +
        `value per model to silence this warning.`,
      );
    }
  }

  // Task-level timeout enforcement — phased or single query executes below.
  const taskAbortController = new AbortController();
  const timeoutMs = config.timeoutSeconds * MS_PER_SECOND;
  const timeoutId = setTimeout(() => {
    console.warn(`[agent] Run ${runId} exceeded timeout (${config.timeoutSeconds}s), aborting`);
    taskAbortController.abort(new Error(`Agent run timed out after ${config.timeoutSeconds} seconds`));
  }, timeoutMs);
  timeoutId.unref?.();

  let phaseResults: PhaseResult[] | undefined;
  try {
    let tokensUsed: number;
    let costUsd: number | null;
    let costData: CostResolution;
    let usage: RuntimeUsage;
    let runSessionRef = checkpointState.sessionRef;

    const persistRuntimeState = async (
      currentCheckpointState: RunCheckpointState,
      currentPhaseResults: PhaseResult[] = [],
      currentUsage: RuntimeUsage = aggregateUsage(currentPhaseResults.map((phase) => phase.usage)),
      currentCost: CostResolution = summarizePhaseCosts(currentPhaseResults),
    ) => {
      applyRunUpdate(runId, buildRunAccountingUpdate({
        runtime: runtimeId,
        provider: effectiveProvider,
        model: effectiveModel,
        checkpointState: currentCheckpointState,
        usage: currentUsage,
        costData: currentCost,
        phaseResults: currentPhaseResults,
      }));
    };

    if (config.phases && config.phases.length > 0) {
      const projectRoot = resolve(vaultDir, '..');
      const result = await executePhasedQuery(
        config,
        systemPrompt,
        vaultContext,
        agentId,
        runId,
        taskProviderOverride,
        phaseProviderOverrides,
        options?.instruction,
        options?.embeddingManager,
        taskAbortController,
        projectRoot,
        vaultDir,
        checkpointState,
        persistRuntimeState,
        options,
      );
      tokensUsed = result.tokensUsed;
      costUsd = result.costUsd;
      costData = result.costData;
      usage = result.usage;
      phaseResults = result.phases;
      const requiredPhaseNames = new Set(
        config.phases!.filter((p) => p.required).map((p) => p.name),
      );
      const failedRequired = phaseResults.find(
        (p) => p.status === 'failed' && requiredPhaseNames.has(p.name),
      );
      if (failedRequired) {
        throw new Error(
          `Required phase "${failedRequired.name}" failed: ${failedRequired.summary}`,
        );
      }
    } else {
      // Single-query execution (backward compatible)
      const taskPrompt = composeTaskPrompt(
        vaultContext,
        config.taskDisplayName,
        config.taskPrompt,
        options?.instruction,
      );

      // Provider priority for single-query: myco.yaml task override → task execution config → default
      const singleProvider = taskProviderOverride ?? config.execution?.provider;

      const result = await executeSingleQuery(
        config,
        systemPrompt,
        taskPrompt,
        agentId,
        runId,
        singleProvider,
        options?.embeddingManager,
        taskAbortController,
        vaultDir,
        checkpointState.sessionRef,
        checkpointState.sessionData,
      );
      tokensUsed = result.tokensUsed;
      costUsd = result.costUsd;
      costData = result.costData;
      usage = result.usage;
      runSessionRef = result.sessionRef;
      checkpointState.sessionRef = result.sessionRef;
      checkpointState.sessionData = result.sessionData;
      await persistRuntimeState(checkpointState, undefined, usage, costData);

      // dry-run: postconditions verify real writes landed; no writes happened, so nothing to validate.
      if (!options?.dryRun) {
        const postconditionError = validateTaskPostconditions({
          runId,
          taskName: config.taskName,
        });
        if (postconditionError) {
          throw new Error(postconditionError);
        }
      }
    }

    clearTimeout(timeoutId);
    logTokenBudgetPressure(config.taskName, usage, effectiveProvider);
    await finalizeOnTaskSuccess({
      taskName: config.taskName,
      agentId,
      runId,
      runContext: options?.runContext,
      instruction: options?.instruction,
    });
    const completedAt = epochSeconds();
    updateRunStatus(runId, STATUS_COMPLETED, {
      resumable: 0,
      resume_status: null,
      completed_at: completedAt,
      tokens_used: tokensUsed,
      ...buildRunAccountingUpdate({
        runtime: runtimeId,
        provider: effectiveProvider,
        model: effectiveModel,
        checkpointState,
        usage,
        costData,
        phaseResults,
        sessionRef: runSessionRef,
      }),
    });

    return {
      runId,
      status: STATUS_COMPLETED,
      tokensUsed,
      costUsd,
      costSource: costData.source,
      costData,
      runtime: runtimeId,
      provider: effectiveProvider?.type,
      model: effectiveModel,
      ...(phaseResults ? { phases: phaseResults } : {}),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    // Mark run as failed, preserving phase results. The SDK may throw
    // non-Error objects, so extract a best-effort message.
    let errorMessage: string;
    if (err instanceof Error) {
      errorMessage = err.message || err.constructor.name || 'Error (no message)';
      if (err.stack) errorMessage += `\n${err.stack.split('\n').slice(0, 3).join('\n')}`;
    } else if (typeof err === 'string') {
      errorMessage = err || 'Empty string error';
    } else {
      try { errorMessage = JSON.stringify(err); } catch { errorMessage = 'Unserializable error'; }
    }
    const failedAt = epochSeconds();

    // Log to stderr (daemon may capture) and to structured log
    console.error(`[agent] Run ${runId} failed: ${errorMessage}`);

    try {
      const usage = aggregateUsage(phaseResults?.map((phase) => phase.usage) ?? []);
      logTokenBudgetPressure(config.taskName, usage, effectiveProvider);
      const costData = phaseResults ? summarizePhaseCosts(phaseResults) : await resolveCost({
        runtime: runtimeId,
        provider: effectiveProvider,
        model: effectiveModel,
        usage,
      });
      updateRunStatus(runId, STATUS_FAILED, {
        resumable: 1,
        resume_status: RESUME_STATUS_READY,
        completed_at: failedAt,
        tokens_used: usage.totalTokens ?? phaseResults?.reduce((sum, phase) => sum + phase.tokensUsed, 0) ?? undefined,
        error: errorMessage,
        ...buildRunAccountingUpdate({
          runtime: runtimeId,
          provider: effectiveProvider,
          model: effectiveModel,
          checkpointState,
          usage,
          costData,
          phaseResults,
        }),
      });
    } catch (dbErr) {
      // DB failure in error path — log it but don't mask the original error
      console.error(`[agent] Failed to save error to DB:`, dbErr);
    }

    await cleanupOnTaskFailure({
      taskName: config.taskName,
      vaultDir,
      runContext: options?.runContext,
    });

    return {
      runId,
      status: STATUS_FAILED,
      error: errorMessage,
      runtime: runtimeId,
      provider: effectiveProvider?.type,
      model: effectiveModel,
      ...(phaseResults ? { phases: phaseResults } : {}),
    };
  }
}

/**
 * Task-specific cleanup fired when a run ends in failure. Exported
 * for direct unit testing — the real executor call site lives in
 * runAgent's catch block.
 *
 * skill-generate: the draft phase stages SKILL.md + manifest to
 * .myco/staging/skills/<candidate_id>/ via vault_stage_skill. If the
 * validate phase (or any later required phase) fails, the staged
 * content must be removed so the next generate cycle doesn't find an
 * orphan draft. The daemon periodic sweep is the belt-and-suspenders
 * backup for anything this hook misses.
 */
export async function cleanupOnTaskFailure(args: {
  taskName: string | undefined;
  vaultDir: string | undefined;
  runContext: RunOptions['runContext'];
}): Promise<void> {
  if (args.taskName !== SKILL_GENERATE_TASK) return;
  if (!args.vaultDir) return;
  const candidateId = args.runContext?.candidate_id;
  if (!candidateId) return;

  try {
    const { cleanupStagedSkill } = await import('./tools/skill-staging.js');
    cleanupStagedSkill(args.vaultDir, candidateId);
    console.warn(
      `[agent] skill-generate failed — cleaned up staging for candidate ${candidateId}`,
    );
  } catch (cleanupErr) {
    console.warn(
      `[agent] Failed to clean staging for candidate ${candidateId}:`,
      cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
    );
  }
}

/**
 * Task-specific success hooks fired after a run completes cleanly.
 *
 * cortex-instructions: the agent writes the final markdown via `vault_report`.
 * The stored artifact read by the Cortex page and session-start injection lives
 * in `cortex_instructions`, so the report must be materialized into that table
 * once the run succeeds.
 */
export async function finalizeOnTaskSuccess(args: {
  taskName: string | undefined;
  agentId: string;
  runId: string;
  runContext: RunOptions['runContext'];
  instruction?: string;
}): Promise<void> {
  if (args.taskName !== CORTEX_INSTRUCTIONS_TASK) return;

  const reports = listReports(args.runId);
  let report: typeof reports[number] | undefined;
  for (let i = reports.length - 1; i >= 0; i -= 1) {
    if (reports[i]?.action === CORTEX_INSTRUCTIONS_REPORT_ACTION) {
      report = reports[i];
      break;
    }
  }
  if (!report) {
    throw new Error('cortex-instructions completed without a cortex_instructions report');
  }

  const details = tryParseJson<Record<string, unknown>>(report.details);
  const rawContent = details?.[CORTEX_INSTRUCTIONS_CONTENT_KEY];
  const content = typeof rawContent === 'string' ? rawContent : null;
  if (!content) {
    throw new Error('cortex-instructions completed without report details.content');
  }

  upsertCortexInstructions({
    agent_id: args.agentId,
    content,
    input_hash: args.runContext?.cortex_instruction_input_hash ?? fallbackInstructionHash(args.instruction),
    source_run_id: args.runId,
    generated_at: report.created_at,
  });
}

function fallbackInstructionHash(instruction: string | undefined): string {
  return crypto
    .createHash(CONTENT_HASH_ALGORITHM)
    .update(instruction ?? '')
    .digest('hex');
}
