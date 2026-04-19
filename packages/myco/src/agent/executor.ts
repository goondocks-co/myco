/** Agent executor — orchestrates a single agent run end to end. */

import crypto from 'node:crypto';
import { resolve } from 'node:path';
import {
  epochSeconds,
  DEFAULT_AGENT_ID,
  MS_PER_SECOND,
  CONTENT_HASH_ALGORITHM,
} from '@myco/constants.js';
import { tryParseJson } from '@myco/utils/json.js';
import { initDatabase, vaultDbPath } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import { listReports } from '@myco/db/queries/reports.js';
import { getDefaultTask } from '@myco/db/queries/tasks.js';
import {
  insertRun,
  updateRunStatus,
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
import { resolveRunConfig } from './config-resolver.js';
import { resolveOllamaContextVariants } from './ollama-context.js';
import { resolveReasoningModel } from './reasoning-levels.js';
import { validateTaskPostconditions } from './task-postconditions.js';
import { CORTEX_INSTRUCTIONS_TASK, SKILL_GENERATE_TASK } from './instruction-builders.js';
import { resolveCost } from './cost/index.js';
import {
  aggregateUsage,
  buildUsageData,
  parseCheckpointState,
  resolveProviderForResume,
  serializeCheckpointState,
} from './executor-state.js';
import {
  analyzeRuntimeTokenBudget,
  buildRunAccountingUpdate,
  summarizePhaseCosts,
} from './run-accounting.js';
import { composeTaskPrompt, composePhasePrompt } from './prompt-composition.js';
import { warnUnknownPhaseOverrides, resolvePhaseExecution } from './phase-resolver.js';
import { executePhasedQuery, executeSingleQuery, type PhaseLoopContext } from './phase-loop.js';
import type { RunCheckpointState } from './executor-state.js';
export { composeTaskPrompt, composePhasePrompt };
export { resolvePhaseExecution } from './phase-resolver.js';
export type { MycoYamlPhaseOverrides } from './phase-resolver.js';
import type { CostResolution } from './cost/types.js';
import type { ProviderConfig } from './types.js';
import type {
  RunOptions,
  AgentRunResult,
  EffectiveConfig,
  PhaseResult,
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

/** Report action emitted by the Cortex instructions task. */
const CORTEX_INSTRUCTIONS_REPORT_ACTION = 'cortex_instructions';

/** Details key storing the final markdown content in the Cortex report. */
const CORTEX_INSTRUCTIONS_CONTENT_KEY = 'content';

const TOKEN_BUDGET_PRESSURE_STATUSES = new Set(['warning', 'post_run_pressure']);

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
  const checkpointState: RunCheckpointState = resumedRun
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

    const projectRoot = resolve(vaultDir, '..');

    // Assemble the PhaseLoopContext once. `checkpointState` is mutable by
    // reference — the loop updates it in place and we read back its final
    // contents below for run finalization.
    const ctx: PhaseLoopContext = {
      config,
      systemPrompt,
      vaultContext,
      agentId,
      runId,
      taskProviderOverride,
      phaseProviderOverrides,
      instruction: options?.instruction,
      embeddingManager: options?.embeddingManager,
      abortController: taskAbortController,
      projectRoot,
      vaultDir,
      options,
      checkpointState,
      persistCheckpoints: persistRuntimeState,
    };

    if (config.phases && config.phases.length > 0) {
      const result = await executePhasedQuery(ctx);
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
      const taskPrompt = composeTaskPrompt({
        vaultContext,
        taskDisplayName: config.taskDisplayName,
        taskPrompt: config.taskPrompt,
        instruction: options?.instruction,
      });

      // Provider priority for single-query: myco.yaml task override → task execution config → default
      const singleProvider = taskProviderOverride ?? config.execution?.provider;

      const result = await executeSingleQuery(
        ctx,
        taskPrompt,
        singleProvider,
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

  const parsedDetails = tryParseJson(report.details);
  const details = (parsedDetails && typeof parsedDetails === 'object' && !Array.isArray(parsedDetails))
    ? (parsedDetails as Record<string, unknown>)
    : null;
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
