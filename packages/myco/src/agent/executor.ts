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
import { getMachineId } from '@myco/machine-id.js';
import { projectScopeFromRequestContext, requireProjectId, rowProjectIdFromRequestContext } from '@myco/grove/request-context.js';
import { getDefaultTask } from '@myco/db/queries/tasks.js';
import {
  insertRun,
  updateRunStatus,
  applyRunUpdate,
  getRun,
  getRunningRunForTask,
  supersedeEquivalentResumableRuns,
  RESUME_STATUS_READY,
  RESUME_STATUS_SESSION_EXPIRED,
  RESUME_STATUS_POSTCONDITION_UNSATISFIABLE,
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
import { validateTaskPostconditions, PostconditionUnsatisfiableError } from './task-postconditions.js';
import {
  CORTEX_INSTRUCTIONS_TASK,
  SKILL_GENERATE_TASK,
  SKILL_SURVEY_TASK,
  SKILL_SURVEY_WATERMARK_KEY,
  CANOPY_MAP_TASK,
  CANOPY_MAP_REPORT_ACTION,
  CANOPY_MAP_CONTENT_KEY,
} from './instruction-builders.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { resolveCost } from './cost/index.js';
import {
  aggregateUsage,
  buildUsageData,
  parseCheckpointState,
  resolveProviderForResume,
  serializeCheckpointState,
} from './executor-state.js';
import { getAgentHarness } from './harness/index.js';
import { HarnessExecutionError } from './harness/types.js';
import { buildAuditEventHooks } from './harness/audit-hooks.js';
import type { HarnessHooks } from './harness/hooks.js';
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

/**
 * Grace added to the task timeout when judging whether a 'running' row is
 * stale. A run loop enforces its own timeout abort, so a 'running' row older
 * than timeout + margin has no live driver (e.g. the process died between
 * boot-recovery sweeps) and must not block scheduling forever.
 */
const STALE_RUNNING_RUN_MARGIN_SECONDS = 300;

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

/**
 * Merge the default audit-event hooks (always on) with any caller-supplied
 * hooks (RunOptions.hooks). Both fire for every event — the caller's hooks
 * are additive, not a replacement for the audit recorder. Each merged
 * callback is best-effort: a failure in either side must not stop the
 * other from running or bubble into the tool/phase call it's observing.
 */
function mergeHooks(defaultHooks: HarnessHooks, callerHooks: HarnessHooks | undefined): HarnessHooks {
  if (!callerHooks) return defaultHooks;
  return {
    preToolUse: async (event) => {
      await Promise.allSettled([defaultHooks.preToolUse?.(event), callerHooks.preToolUse?.(event)]);
    },
    postToolUse: async (event) => {
      await Promise.allSettled([defaultHooks.postToolUse?.(event), callerHooks.postToolUse?.(event)]);
    },
    phaseStart: async (event) => {
      await Promise.allSettled([defaultHooks.phaseStart?.(event), callerHooks.phaseStart?.(event)]);
    },
    phaseEnd: async (event) => {
      await Promise.allSettled([defaultHooks.phaseEnd?.(event), callerHooks.phaseEnd?.(event)]);
    },
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

  if (resumedRun) {
    // Restore any input the caller omitted from the resumed row so every
    // resume path (scheduler and manual endpoint) executes with the original
    // dispatch's inputs. dry_run is the load-bearing one: a resumed dry-run
    // must never perform real writes. Caller-supplied values still win.
    options = {
      ...options,
      instruction: options?.instruction ?? resumedRun.instruction ?? undefined,
      runContext: options?.runContext ?? parseStoredRunContext(resumedRun.run_context),
      dryRun: options?.dryRun ?? resumedRun.dry_run,
      executionOverrides: options?.executionOverrides
        ?? (resumedRun.execution_overrides as RunOptions['executionOverrides'])
        ?? (resumedRun.reasoning_level
          ? { reasoningLevel: resumedRun.reasoning_level }
          : undefined),
    };
  }

  const requestedTask = options?.task ?? resumedRun?.task ?? undefined;

  const {
    config: resolvedConfig,
    definitionsDir,
    taskProviderOverride: resolvedTaskProvider,
    phaseProviderOverrides: resolvedPhaseOverrides,
    taskParams: resolvedTaskParams,
    semanticWriteCheckEnabledDefault,
  } = resolveRunConfig(agentId, requestedTask, vaultDir, options?.requestContext?.groveId ?? null);

  // Resolved once here; a resumed run already has this baked into
  // options.executionOverrides.semanticWriteCheckEnabled via the restore
  // block above, so semanticWriteCheckEnabledDefault only matters for a
  // run's FIRST dispatch. Runs dispatched before the snapshot existed (execution_overrides null/keyless)
  // fall back to the CURRENT config value — safe while the default is false.
  const semanticWriteCheckEnabled =
    options?.executionOverrides?.semanticWriteCheckEnabled
    ?? semanticWriteCheckEnabledDefault
    ?? false;
  const classifierReasoningLevel =
    options?.executionOverrides?.classifierReasoningLevel
    ?? 'low';

  // Block duplicate runs of the SAME task — different tasks may run
  // concurrently. A 'running' row older than the task timeout (+ margin)
  // is treated as not-running: log it and proceed (boot recovery owns
  // mutating the orphaned row).
  {
    const effectiveTask = requestedTask
      ?? getDefaultTask(agentId)?.id;
    if (effectiveTask) {
      const running = getRunningRunForTask(
        agentId,
        effectiveTask,
        scope,
        resolvedConfig.timeoutSeconds + STALE_RUNNING_RUN_MARGIN_SECONDS,
      );
      if (running?.stale) {
        options?.logger?.warn('agent.run.stale-running-row', `Ignoring stale running row for task ${effectiveTask}`, {
          taskName: effectiveTask,
          staleRunId: running.id,
          startedAt: running.started_at,
        });
      } else if (running) {
        return {
          runId: running.id,
          status: STATUS_SKIPPED,
          reason: SKIP_REASON_ALREADY_RUNNING,
        };
      }
    }
  }

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
    semanticWriteCheckEnabled,
    classifierReasoningLevel,
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
  const runId = options?.resumeRunId ?? options?.runId ?? crypto.randomUUID();
  const runHooks = mergeHooks(buildAuditEventHooks(runId, projectId ?? null), options?.hooks);
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

  const systemPrompt = loadSystemPrompt(definitionsDir, config.systemPromptPath);
  const vaultContext = buildVaultContext(agentId, requireProjectId(options!.requestContext!, 'agent run'));

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

  // Re-check the duplicate-run guard synchronously, immediately before row
  // creation. The early guard alone is not single-flight anymore: the
  // resolver awaits above let two same-tick dispatches both pass it before
  // either inserts. This check and the insert below run with no await
  // between them, so the second dispatch always sees the first one's row.
  {
    const running = getRunningRunForTask(
      agentId,
      config.taskName,
      scope,
      config.timeoutSeconds + STALE_RUNNING_RUN_MARGIN_SECONDS,
    );
    if (running && !running.stale) {
      clearTimeout(timeoutId);
      return {
        runId: running.id,
        status: STATUS_SKIPPED,
        reason: SKIP_REASON_ALREADY_RUNNING,
      };
    }
  }

  // Run-row creation sits immediately before the try so nothing throwable
  // (prompt loading, vault context, provider resolution above) can leave an
  // orphaned 'running' row that the catch below never marks failed.
  const now = epochSeconds();
  // Fields common to both a fresh dispatch and a resume attempt. `started_at`
  // is deliberately NOT here — see the two branches below: a fresh dispatch
  // stamps it once (original dispatch time), a resume must never touch it.
  const runStart = {
    status: STATUS_RUNNING,
    harness: harnessId,
    model: effectiveModel,
    checkpoints: serializeCheckpointState(checkpointState),
  } as const;
  if (!resumedRun) {
    // Resolved once here, same as the reasoningLevel column below. Folding it
    // into the executionOverrides snapshot too keeps the resume-restore
    // ladder's rung 2 (`resumedRun.execution_overrides`) complete on its own:
    // since this blob is now ALWAYS non-null (it always carries
    // semanticWriteCheckEnabled/classifierReasoningLevel), rung 3
    // (`resumedRun.reasoning_level ? {reasoningLevel} : undefined`) would
    // otherwise never run, and a resumed run would re-resolve reasoningLevel
    // from live config instead of the original dispatch's tier.
    // Precedence matches every live execution path (executeSingleQuery,
    // the phase resolver, the orchestrator tier ladder): the scoped
    // execution block wins over the task-level default. Snapshotting the
    // inverse order would persist a tier the run never actually used.
    const resolvedReasoningLevel =
      options?.executionOverrides?.reasoningLevel
      ?? config.execution?.reasoningLevel
      ?? config.reasoningLevel
      ?? null;
    insertRun({
      id: runId,
      project_id: projectId,
      agent_id: agentId,
      task: config.taskName,
      instruction: options?.instruction ?? null,
      ...runStart,
      started_at: now,
      provider: effectiveProvider?.type ?? null,
      usage_data: buildUsageData({}),
      run_context: options?.runContext ? JSON.stringify(options.runContext) : null,
      dryRun: options?.dryRun ?? false,
      reasoningLevel: resolvedReasoningLevel,
      executionOverrides: {
        ...(options?.executionOverrides ?? {}),
        ...(resolvedReasoningLevel ? { reasoningLevel: resolvedReasoningLevel } : {}),
        semanticWriteCheckEnabled,
        classifierReasoningLevel,
      },
    });
  } else {
    // `started_at` is preserved as the run's ORIGINAL dispatch time across
    // every resume attempt — it is never re-stamped here. `resumed_at` is
    // the per-attempt recency field: it advances on every resume and is the
    // signal any "how long has the CURRENT attempt been alive" or "when did
    // this row last move" consumer should read (COALESCE(resumed_at,
    // started_at)). error and the checkpoint's postConditionFailed flag (on
    // any phase that succeeds this time) still reflect only the LATEST
    // attempt — per-attempt truth for prior attempts lives in the daemon log
    // + agent_run_events, not in this row. The supersede sweep and belt
    // compare completions against `started_at` directly (see runs.ts) now
    // that it is stable dispatch-order evidence.
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

  let phaseResults: PhaseResult[] | undefined;
  // Declared outside the try so the catch block below can prefer whatever
  // executeSingleQuery/executePhasedQuery already populated here over
  // rebuilding usage from scratch. A postcondition check can throw a plain
  // Error AFTER these locals hold real, billed usage (see the catch block's
  // "run-end postcondition" comment) — without hoisting, that usage was
  // invisible to the catch and contract-failed runs persisted tokens_used=0
  // despite full billed turns (observed on ea34158d, 0f22a8c3).
  let tokensUsed: number | undefined;
  let costUsd: number | null | undefined;
  let costData: CostResolution | undefined;
  let usage: RuntimeUsage | undefined;
  try {
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
      treeAvailable: options?.treeAvailable,
      requestContext: options?.requestContext,
      options,
      checkpointState,
      persistCheckpoints: persistHarnessState,
      hooks: runHooks,
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
      const postconditionError = validateTaskPostconditions({
        runId,
        taskName: config.taskName,
        dryRun: options?.dryRun ?? false,
      });
      if (postconditionError) {
        // Part 3 of the resume-admission gate: a resume that executed ZERO
        // fresh phases (every phase this attempt was trusted from the
        // checkpoint) can never satisfy a missing contract by retrying —
        // retrying re-runs nothing. Throw the typed error so the catch
        // block below terminal-marks in one attempt instead of burning the
        // scheduler's resume budget.
        if (options?.resumeRunId && result.executedPhaseCount === 0) {
          throw new PostconditionUnsatisfiableError(postconditionError);
        }
        throw new Error(postconditionError);
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

      const postconditionError = validateTaskPostconditions({
        runId,
        taskName: config.taskName,
        dryRun: options?.dryRun ?? false,
      });
      if (postconditionError) {
        throw new Error(postconditionError);
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

    // Part 1 (supersede) primary enforcement: this run just completed, so
    // any OTHER resumable failed run for the same (agent, task, project
    // scope, dry_run) — the same scheduled job — is stale by definition —
    // its checkpoints, gate verdicts, and watermarks are superseded by this
    // completion. Terminal-mark it now rather than let the scheduler
    // re-admit it. `instruction` is intentionally excluded from the
    // equivalence key (see appendSupersedeEquivalenceCondition): tasks like
    // skill-evolve build their instruction dynamically per run, so keying
    // on it would prevent this sweep from ever retiring that job's zombies.
    supersedeEquivalentResumableRuns(runId, {
      agentId,
      taskName: config.taskName,
      scope,
      dryRun: options?.dryRun ?? false,
    });

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

    // Captured before the inner try block shadows `usage`/`costData` with
    // its own failure-record locals — see the priority-order comment below.
    const preThrowUsage = usage;
    const preThrowCostData = costData;

    try {
      // Usage/cost for the failure record, in priority order:
      //  1. phaseResults — always authoritative when present (a phased run
      //     that got at least one phase in).
      //  2. `preThrowUsage`/`preThrowCostData` — already populated by
      //     executeSingleQuery (or executePhasedQuery) BEFORE a run-end
      //     postcondition check throws a plain Error. Postcondition failures
      //     are not HarnessExecutionError, so without this branch their real,
      //     billed usage was invisible here and the failure recorded
      //     tokens_used=0 (observed on ea34158d, 0f22a8c3).
      //  3. HarnessExecutionError.telemetry — the harness crashed before
      //     executeSingleQuery returned, so its own partial-usage rescue is
      //     the only source.
      //  4. empty usage — nothing was ever populated (crashed before any
      //     turn).
      const failureTelemetry = err instanceof HarnessExecutionError ? err.telemetry : undefined;
      const usage = phaseResults
        ? aggregateUsage(phaseResults.map((phase) => phase.usage))
        : preThrowUsage ?? failureTelemetry?.usage ?? aggregateUsage([]);
      logTokenBudgetPressure(config.taskName, usage, effectiveProvider, options?.logger);
      const costData = phaseResults
        ? summarizePhaseCosts(phaseResults)
        : preThrowCostData ?? await resolveCost({
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

      // Part 3 of the resume-admission gate: the typed error thrown at the
      // run-end seam above means this resume executed ZERO fresh phases and
      // still failed its postcondition — deterministically unresumable, not
      // a transient failure worth 3 scheduler retries. Unlike sessionExpired,
      // checkpoints are PRESERVED (not nulled) — they're not a poisoned
      // session id, and keeping them lets an operator inspect what the
      // restored phases actually produced.
      const postconditionUnsatisfiable = err instanceof PostconditionUnsatisfiableError;

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

      const resumable = sessionExpired || postconditionUnsatisfiable ? 0 : 1;
      const resumeStatus = sessionExpired
        ? RESUME_STATUS_SESSION_EXPIRED
        : postconditionUnsatisfiable
          ? RESUME_STATUS_POSTCONDITION_UNSATISFIABLE
          : RESUME_STATUS_READY;

      updateRunStatus(runId, STATUS_FAILED, {
        resumable,
        resume_status: resumeStatus,
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
      runId,
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
  runId?: string;
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
  const projectId = requireProjectId(args.requestContext, 'canopy-map writer');
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

/**
 * Parse a persisted `agent_runs.run_context` JSON column back into
 * RunOptions.runContext. Null, non-object, and unparseable payloads all
 * degrade to undefined (corruption tolerance — a resume must not fail on a
 * bad column).
 */
function parseStoredRunContext(raw: string | null): RunOptions['runContext'] {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as RunOptions['runContext'];
    }
    return undefined;
  } catch {
    return undefined;
  }
}
