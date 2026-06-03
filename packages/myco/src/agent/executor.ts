/** Agent executor — orchestrates a single agent run end to end. */

import crypto from 'node:crypto';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import {
  epochSeconds,
  estimateTokens,
  DEFAULT_AGENT_ID,
  MS_PER_SECOND,
  CONTENT_HASH_ALGORITHM,
} from '@myco/constants.js';
import { tryParseJson } from '@myco/utils/json.js';
import { errorMessage as toErrorMessage } from '@myco/utils/error-message.js';
import { initDatabase, vaultDbPath } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import { setState } from '@myco/db/queries/agent-state.js';
import { listReports } from '@myco/db/queries/reports.js';
import { writeCanopyMap } from '@myco/canopy/map/store.js';
import { getMachineId } from '@myco/daemon/machine-id.js';
import { projectScopeFromRequestContext, rowProjectIdFromRequestContext } from '@myco/grove/request-context.js';
import { getDefaultTask } from '@myco/db/queries/tasks.js';
import {
  insertRun,
  updateRunStatus,
  applyRunUpdate,
  getRun,
  getRunningRunForTask,
  RESUME_STATUS_READY,
  RESUME_STATUS_SESSION_EXPIRED,
  STATUS_RUNNING,
  STATUS_COMPLETED,
  STATUS_FAILED,
} from '@myco/db/queries/runs.js';
import { loadSystemPrompt } from './loader.js';
import { buildVaultContext } from './context.js';
import { resolveRunConfig } from './config-resolver.js';
import { inferHarnessFromProviderType } from './provider-harness.js';
import { resolveOllamaContextVariants } from './ollama-context.js';
import { resolveLmStudioContextLoads } from './lmstudio-context.js';
import { resolveReasoningModel } from './reasoning-levels.js';
import { validateTaskPostconditions } from './task-postconditions.js';
import {
  CORTEX_INSTRUCTIONS_TASK,
  SKILL_GENERATE_TASK,
  SKILL_SURVEY_TASK,
  SKILL_SURVEY_WATERMARK_KEY,
  CANOPY_MAP_TASK,
  CANOPY_MAP_REPORT_ACTION,
  CANOPY_MAP_CONTENT_KEY,
} from './instruction-builders.js';
import { resolveCost } from './cost/index.js';
import {
  aggregateUsage,
  buildUsageData,
  parseCheckpointState,
  resolveProviderForResume,
  serializeCheckpointState,
} from './executor-state.js';
import { getAgentHarness } from './harness/index.js';
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
  provider: ProviderConfig | undefined,
  logger: RunOptions['logger'],
): void {
  const budget = analyzeRuntimeTokenBudget(usage, provider);
  if (!TOKEN_BUDGET_PRESSURE_STATUSES.has(budget.status)) return;
  logger?.warn('agent.token-budget-pressure', `${taskName} token budget ${budget.status}`, {
    task: taskName,
    status: budget.status,
    utilizationPercent: budget.utilizationPercent,
    contextWindowTokens: budget.contextWindowTokens,
    peakRequestTotalTokens: budget.peakRequestTotalTokens,
  });
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
  const db = initDatabase(options?.requestContext?.databasePath ?? vaultDbPath(vaultDir));
  // Real machine id (not the 'local' default) so the v52 conversion runs.
  createSchema(db, getMachineId());

  const agentId = options?.agentId ?? DEFAULT_AGENT_ID;
  const projectId = rowProjectIdFromRequestContext(options?.requestContext);
  const scope = projectScopeFromRequestContext(options?.requestContext);
  const resumedRun = options?.resumeRunId ? getRun(options.resumeRunId, scope) : null;
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
      const runningId = getRunningRunForTask(agentId, effectiveTask, scope);
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
    taskParams: resolvedTaskParams,
  } = resolveRunConfig(agentId, requestedTask, vaultDir, options?.requestContext?.groveId ?? null);

  // Build an effective config for this run by layering per-run overrides
  // on top of the resolved config WITHOUT mutating the resolveRunConfig
  // return value. Each cell in an evaluation matrix reuses the task's
  // resolved config and varies one or more of harness / reasoning / model —
  // downstream code (provider selection, model routing, harness dispatch)
  // reads from these fields, so we produce a fresh EffectiveConfig here.
  const overrideHarness = options?.executionOverrides?.harness;
  const overrideProvider = options?.executionOverrides?.provider;
  const runHarness = overrideHarness
    ?? inferHarnessFromProviderType(overrideProvider?.type)
    ?? resolvedConfig.harness;
  const overrideReasoning = options?.executionOverrides?.reasoningLevel;
  const overrideModel = options?.executionOverrides?.model;
  const taskParams = options?.taskParams
    ? { ...(resolvedTaskParams ?? {}), ...options.taskParams }
    : resolvedTaskParams;
  const config: EffectiveConfig = {
    ...resolvedConfig,
    harness: runHarness,
    dryRun: options?.dryRun ?? false,
    ...(taskParams ? { taskParams } : {}),
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
  let taskProviderOverride = overrideProvider ?? resolvedTaskProvider;
  let phaseProviderOverrides = resolvedPhaseOverrides;

  // Top-level provider override from RunOptions.executionOverrides wins over
  // both the myco.yaml task override AND the task YAML execution provider.
  // This lets an operator (RunTaskDialog / eval matrix) swap provider/base URL/
  // context length for a single run without modifying any persistent config.
  const baseProvider =
    overrideProvider
    ?? taskProviderOverride
    ?? config.execution?.provider;
  const runId = options?.resumeRunId ?? crypto.randomUUID();
  const now = epochSeconds();
  let harnessId = runHarness;
  let effectiveModel = resolveReasoningModel(
    config.execution?.reasoningLevel ?? config.reasoningLevel,
    baseProvider,
    config.model,
  );
  const checkpointState: RunCheckpointState = resumedRun
    ? parseCheckpointState(resumedRun.checkpoints)
    : {
      schemaVersion: 2,
      harness: harnessId,
      provider: baseProvider?.type,
      providerConfig: baseProvider,
      model: effectiveModel,
      phases: {},
    };
  if (resumedRun) {
    harnessId = resumedRun.harness ?? checkpointState.harness ?? harnessId;
    effectiveModel = resumedRun.model ?? checkpointState.model ?? effectiveModel;
  }
  const harness = getAgentHarness(harnessId);
  const effectiveProvider = resolveProviderForResume(
    baseProvider,
    resumedRun,
    checkpointState,
    effectiveModel,
  );
  if (!resumedRun) {
    checkpointState.harness = harnessId;
    checkpointState.provider = effectiveProvider?.type;
    checkpointState.providerConfig = effectiveProvider;
    checkpointState.model = effectiveModel;
  } else {
    checkpointState.harness = checkpointState.harness ?? harnessId;
    checkpointState.provider = checkpointState.provider ?? effectiveProvider?.type;
    checkpointState.providerConfig = checkpointState.providerConfig ?? effectiveProvider;
    checkpointState.model = checkpointState.model ?? effectiveModel;
  }

  const runStart = {
    status: STATUS_RUNNING,
    harness: harnessId,
    model: effectiveModel,
    checkpoints: serializeCheckpointState(checkpointState),
    started_at: now,
  } as const;
  if (!resumedRun) {
    insertRun({
      id: runId,
      project_id: projectId,
      agent_id: agentId,
      task: config.taskName,
      instruction: options?.instruction ?? null,
      ...runStart,
      provider: effectiveProvider?.type ?? null,
      usage_data: buildUsageData({}),
      dryRun: options?.dryRun ?? false,
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
    }, scope);
  }

  const systemPrompt = loadSystemPrompt(definitionsDir, config.systemPromptPath);
  const vaultContext = buildVaultContext(agentId, options!.requestContext!.projectId);

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
      options?.logger?.warn(
        'agent.ollama.context-variant-conflict',
        `Ollama model "${conflict.model}" referenced with conflicting context_length values — reconciled to ${conflict.resolved}`,
        {
          model: conflict.model,
          values: conflict.values,
          resolved: conflict.resolved,
        },
      );
    }
  }

  // Same shape as the Ollama resolver, but for LM Studio: loads the model
  // via /api/v1/models/load with the configured context_length. Only runs
  // when context_length is explicitly set on an lmstudio provider; unset
  // passes through to whatever the GUI already has loaded.
  {
    const resolved = await resolveLmStudioContextLoads(
      taskProviderOverride,
      phaseProviderOverrides,
      undefined,
      config.execution?.reasoningLevel ?? config.reasoningLevel,
    );
    taskProviderOverride = resolved.taskProvider;
    phaseProviderOverrides = resolved.phaseOverrides;
    for (const conflict of resolved.conflicts) {
      options?.logger?.warn(
        'agent.lmstudio.context-conflict',
        `LM Studio model "${conflict.model}" referenced with conflicting context_length values — reconciled to ${conflict.resolved}`,
        {
          model: conflict.model,
          values: conflict.values,
          resolved: conflict.resolved,
        },
      );
    }
  }

  // Task-level timeout enforcement — phased or single query executes below.
  const taskAbortController = new AbortController();
  const timeoutMs = config.timeoutSeconds * MS_PER_SECOND;
  const timeoutId = setTimeout(() => {
    options?.logger?.warn('agent.run.timeout', `Run ${runId} exceeded timeout, aborting`, {
      runId,
      taskName: config.taskName,
      timeoutSeconds: config.timeoutSeconds,
    });
    taskAbortController.abort(new Error(`Agent run timed out after ${config.timeoutSeconds} seconds`));
  }, timeoutMs);
  timeoutId.unref?.();

  let phaseResults: PhaseResult[] | undefined;
  try {
    let tokensUsed: number;
    let costUsd: number | null;
    let costData: CostResolution;
    let usage: RuntimeUsage;
    let runSessionRef = checkpointState.harnessState?.ref ?? checkpointState.sessionRef;

    const persistHarnessState = async (
      currentCheckpointState: RunCheckpointState,
      currentPhaseResults: PhaseResult[] = [],
      currentUsage: RuntimeUsage = aggregateUsage(currentPhaseResults.map((phase) => phase.usage)),
      currentCost: CostResolution = summarizePhaseCosts(currentPhaseResults),
    ) => {
      applyRunUpdate(runId, buildRunAccountingUpdate({
        harness: harnessId,
        provider: effectiveProvider,
        model: effectiveModel,
        checkpointState: currentCheckpointState,
        usage: currentUsage,
        costData: currentCost,
        phaseResults: currentPhaseResults,
      }), scope);
    };

    const projectRoot = options?.requestContext?.projectRoot ?? resolveProjectRoot(vaultDir);

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
      requestContext: options?.requestContext,
      options,
      checkpointState,
      persistCheckpoints: persistHarnessState,
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
        checkpointState.harnessState?.ref ?? checkpointState.sessionRef,
        checkpointState.harnessState?.data ?? checkpointState.sessionData,
      );
      tokensUsed = result.tokensUsed;
      costUsd = result.costUsd;
      costData = result.costData;
      usage = result.usage;
      runSessionRef = result.sessionRef;
      checkpointState.sessionRef = result.sessionRef;
      checkpointState.sessionData = result.sessionData;
      checkpointState.harnessState = {
        ...(result.sessionRef ? { ref: result.sessionRef } : {}),
        ...(result.sessionData !== undefined ? { data: result.sessionData } : {}),
      };
      await persistHarnessState(checkpointState, undefined, usage, costData);

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
    logTokenBudgetPressure(config.taskName, usage, effectiveProvider, options?.logger);
    await finalizeOnTaskSuccess({
      taskName: config.taskName,
      agentId,
      runId,
      runContext: options?.runContext,
      requestContext: options?.requestContext,
      instruction: options?.instruction,
      dryRun: options?.dryRun,
      vaultDir,
    });
    const completedAt = epochSeconds();
    updateRunStatus(runId, STATUS_COMPLETED, {
      resumable: 0,
      resume_status: null,
      completed_at: completedAt,
      tokens_used: tokensUsed,
      ...buildRunAccountingUpdate({
        harness: harnessId,
        provider: effectiveProvider,
        model: effectiveModel,
        checkpointState,
        usage,
        costData,
        phaseResults,
        sessionRef: runSessionRef,
      }),
    }, scope);

    return {
      runId,
      status: STATUS_COMPLETED,
      tokensUsed,
      costUsd,
      costSource: costData.source,
      costData,
      harness: harnessId,
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

    options?.logger?.error('agent.run.failed', `Run ${runId} failed`, {
      runId,
      taskName: config.taskName,
      error: errorMessage,
    });

    try {
      const usage = aggregateUsage(phaseResults?.map((phase) => phase.usage) ?? []);
      logTokenBudgetPressure(config.taskName, usage, effectiveProvider, options?.logger);
      const costData = phaseResults ? summarizePhaseCosts(phaseResults) : await resolveCost({
        harness: harnessId,
        provider: effectiveProvider,
        model: effectiveModel,
        usage,
      });

      // Detect the "expired SDK session" zombie-run pattern: we were
      // resuming a run whose checkpoint carried a sessionRef, the harness
      // crashed without producing any turns, and the error message looks
      // like an expired/missing session. Marking it `resumable=1, ready`
      // here would re-enqueue it next scheduler tick and loop forever
      // (37 zombies accumulated in issue #118). Terminal-mark it instead
      // and null the checkpoint so nothing else tries to reuse the dead
      // session id.
      const hadPriorSession = Boolean(checkpointState.harnessState?.ref ?? checkpointState.sessionRef)
        || Object.values(checkpointState.phases).some((phase) => Boolean(phase.sessionRef));
      const recordedAnyTurns = (usage.requests ?? 0) > 0
        || (phaseResults?.some((phase) => phase.turnsUsed > 0) ?? false);
      const sessionExpired = Boolean(options?.resumeRunId)
        && hadPriorSession
        && !recordedAnyTurns
        && (harness.classifyError?.(err, { attemptedResume: true }) === 'session-expired');

      const accountingUpdate = buildRunAccountingUpdate({
        harness: harnessId,
        provider: effectiveProvider,
        model: effectiveModel,
        checkpointState,
        usage,
        costData,
        phaseResults,
      });
      if (sessionExpired) {
        accountingUpdate.checkpoints = null;
      }

      updateRunStatus(runId, STATUS_FAILED, {
        resumable: sessionExpired ? 0 : 1,
        resume_status: sessionExpired ? RESUME_STATUS_SESSION_EXPIRED : RESUME_STATUS_READY,
        completed_at: failedAt,
        tokens_used: usage.totalTokens ?? phaseResults?.reduce((sum, phase) => sum + phase.tokensUsed, 0) ?? undefined,
        error: errorMessage,
        ...accountingUpdate,
      }, scope);
    } catch (dbErr) {
      // DB failure in error path — log it but don't mask the original error
      options?.logger?.error('agent.run.db-save-failed', `Failed to save error to DB for run ${runId}`, {
        runId,
        error: toErrorMessage(dbErr),
      });
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
      harness: harnessId,
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
  requestContext?: RunOptions['requestContext'];
  instruction?: string;
  dryRun?: boolean;
  vaultDir?: string;
}): Promise<void> {
  if (args.dryRun) return;

  if (args.taskName === CORTEX_INSTRUCTIONS_TASK) {
    finalizeCortexInstructions(args);
    return;
  }
  if (args.taskName === SKILL_SURVEY_TASK) {
    finalizeSkillSurvey(args);
    return;
  }
  if (args.taskName === CANOPY_MAP_TASK) {
    finalizeCanopyMap(args);
    return;
  }
}

function finalizeSkillSurvey(args: {
  agentId: string;
  runContext: RunOptions['runContext'];
  requestContext?: RunOptions['requestContext'];
}): void {
  const watermark = args.runContext?.skill_survey_watermark;
  if (!watermark) return;
  const projectId = args.requestContext?.projectId;
  if (!projectId) return;
  setState(
    args.agentId,
    projectId,
    SKILL_SURVEY_WATERMARK_KEY,
    String(watermark),
    watermark,
  );
}

function findLastReportByAction(
  runId: string,
  action: string,
  scope: import('@myco/grove/ids.js').ProjectScope,
): ReturnType<typeof listReports>[number] | undefined {
  const reports = listReports(runId, { scope });
  for (let i = reports.length - 1; i >= 0; i -= 1) {
    if (reports[i]?.action === action) return reports[i];
  }
  return undefined;
}

function extractReportContent(
  report: ReturnType<typeof listReports>[number],
  contentKey: string,
): string | null {
  const parsedDetails = tryParseJson(report.details);
  const details = (parsedDetails && typeof parsedDetails === 'object' && !Array.isArray(parsedDetails))
    ? (parsedDetails as Record<string, unknown>)
    : null;
  const rawContent = details?.[contentKey];
  return typeof rawContent === 'string' ? rawContent : null;
}

function finalizeCortexInstructions(args: {
  agentId: string;
  runId: string;
  runContext: RunOptions['runContext'];
  requestContext?: RunOptions['requestContext'];
  instruction?: string;
}): void {
  const report = findLastReportByAction(args.runId, CORTEX_INSTRUCTIONS_REPORT_ACTION, projectScopeFromRequestContext(args.requestContext));
  if (!report) {
    throw new Error('cortex-instructions completed without a cortex_instructions report');
  }
  const content = extractReportContent(report, CORTEX_INSTRUCTIONS_CONTENT_KEY);
  if (!content) {
    throw new Error('cortex-instructions completed without report details.content');
  }

  upsertCortexInstructions({
    project_id: rowProjectIdFromRequestContext(args.requestContext),
    agent_id: args.agentId,
    content,
    input_hash: args.runContext?.cortex_instruction_input_hash ?? fallbackInstructionHash(args.instruction),
    source_run_id: args.runId,
    generated_at: report.created_at,
  });
}

function finalizeCanopyMap(args: {
  runId: string;
  runContext: RunOptions['runContext'];
  requestContext?: RunOptions['requestContext'];
  vaultDir?: string;
}): void {
  if (!args.vaultDir) {
    throw new Error('canopy-map completed but vaultDir is unavailable — cannot resolve project_id');
  }

  const report = findLastReportByAction(args.runId, CANOPY_MAP_REPORT_ACTION, projectScopeFromRequestContext(args.requestContext));
  if (!report) {
    throw new Error('canopy-map completed without a canopy_map report');
  }
  const content = extractReportContent(report, CANOPY_MAP_CONTENT_KEY);
  if (!content) {
    throw new Error('canopy-map completed without report details.content');
  }

  const inputsHash = args.runContext?.canopy_map_inputs_hash;
  if (!inputsHash) {
    // Without a gather-phase hash we'd write a row that the next run
    // can never match against — better to fail loudly than to corrupt
    // the short-circuit gate.
    throw new Error('canopy-map completed without runContext.canopy_map_inputs_hash');
  }

  if (!args.requestContext) {
    throw new Error('canopy-map writer requires a Grove request context — none supplied');
  }
  const projectId = args.requestContext.projectId;
  const machineId = args.requestContext.machineId;
  writeCanopyMap({
    project_id: projectId,
    machine_id: machineId,
    content,
    inputs_hash: inputsHash,
    token_estimate: estimateTokens(content),
    generated_by_run_id: args.runId,
  });
}

function fallbackInstructionHash(instruction: string | undefined): string {
  return crypto
    .createHash(CONTENT_HASH_ALGORITHM)
    .update(instruction ?? '')
    .digest('hex');
}
