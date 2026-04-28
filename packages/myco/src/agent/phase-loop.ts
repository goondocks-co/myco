/**
 * Phase-loop execution for the agent executor.
 *
 * Extracted from `executor.ts` to keep that file focused on orchestrator-
 * level concerns (run lifecycle, DB bookkeeping, finalization hooks). The
 * functions here own the actual per-phase / per-query dispatch into the
 * runtime adapter — `executePhase`, `executeSingleQuery`, and the wave-
 * based loop in `executePhasedQuery`.
 *
 * The functions take a `PhaseLoopContext` parameter object that groups the
 * orchestrator state previously threaded through long argument lists.
 * Mutable fields (`checkpointState`, `persistCheckpoints`) remain
 * references back into the orchestrator, so the outer `runAgent` can read
 * them after the loop completes to drive run finalization.
 */

import { epochSeconds } from '@myco/constants.js';
import { errorMessage as toErrorMessage } from '@myco/utils/error-message.js';
import {
  composeOrchestratorPrompt,
  parseOrchestratorPlan,
  applyDirectives,
  DEFAULT_ORCHESTRATOR_MAX_TURNS,
} from './orchestrator.js';
import { executeContextQueries } from './context-queries.js';
import { resolveReasoningModel } from './reasoning-levels.js';
import { computeWaves, phaseSessionId } from './wave-computation.js';
import { resolveCost } from './cost/index.js';
import {
  abortReasonMessage,
  buildPhaseResult,
  checkpointResultsForResume,
  isExpiredSessionError,
  isSessionResumeFailure,
  type RunCheckpointState,
} from './executor-state.js';
import { getAgentRuntime } from './runtime/index.js';
import { RuntimeExecutionError, type RuntimeToolSurface } from './runtime/types.js';
import { composePhasePrompt } from './prompt-composition.js';
import { resolvePhaseExecution, type MycoYamlPhaseOverrides } from './phase-resolver.js';
import type { CostResolution } from './cost/types.js';
import type { ContextQueryResult } from './context-queries.js';
import type {
  RunOptions,
  EffectiveConfig,
  PhaseDefinition,
  PhaseResult,
  ProviderConfig,
  RuntimeUsage,
} from './types.js';
import { aggregateUsage } from './executor-state.js';
import { summarizePhaseCosts } from './run-accounting.js';
import { executeMapPhase } from './map-phase.js';
import { createVaultTools } from './tools.js';

// ---------------------------------------------------------------------------
// PhaseLoopContext — parameter object carrying orchestrator state into the
// phase-execution functions. Fields marked "by reference" are mutated by the
// loop; the orchestrator reads them back after the loop to finalize the run.
// ---------------------------------------------------------------------------

export interface PhaseLoopContext {
  /** Effective run configuration (includes task YAML + per-run overrides). */
  readonly config: EffectiveConfig;
  /** System prompt loaded from the agent's definitions directory. */
  readonly systemPrompt: string;
  /** Vault context block prepended to every task / phase prompt. */
  readonly vaultContext: string;
  /** Logical agent identifier (e.g. "myco-agent"). */
  readonly agentId: string;
  /** Run UUID — shared across all phases in the run. */
  readonly runId: string;
  /** Task-level provider override (RunOptions > myco.yaml task override). */
  readonly taskProviderOverride?: ProviderConfig;
  /** Per-phase myco.yaml provider/model/maxTurns overrides. */
  readonly phaseProviderOverrides?: MycoYamlPhaseOverrides;
  /** Free-form instruction passed from the caller (RunOptions.instruction). */
  readonly instruction?: string;
  /** Embedding manager — forwarded to tool surface for RAG-enabled tools. */
  readonly embeddingManager?: RunOptions['embeddingManager'];
  /** Run-level abort controller; aborting aborts all in-flight phase queries. */
  readonly abortController?: AbortController;
  /** Absolute path to the project root (one level above the vault dir). */
  readonly projectRoot?: string;
  /** Absolute path to the vault directory. */
  readonly vaultDir?: string;
  /** Raw RunOptions — exposed to honor executionOverrides.phases per-phase. */
  readonly options?: RunOptions;

  // --- mutable, passed by reference ----------------------------------------

  /**
   * Run checkpoint state. `executePhasedQuery` mutates `state.phases[...]`
   * in place and the orchestrator reads the final state for DB persistence.
   */
  readonly checkpointState: RunCheckpointState;
  /** Optional checkpoint-persistence callback invoked between waves. */
  readonly persistCheckpoints?: (state: RunCheckpointState, phases: PhaseResult[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Single-phase execution helper
// ---------------------------------------------------------------------------

/**
 * Execute a single phase query through the selected runtime adapter.
 *
 * Separated from `executePhasedQuery` so waves can dispatch it via
 * `Promise.allSettled`. Emits a runtime retry when session-resume fails
 * against an adapter that advertises `supportsSessionResume`.
 */
export interface ExecutePhaseInput {
  ctx: PhaseLoopContext;
  phasePrompt: string;
  phaseModel: string;
  phase: PhaseDefinition;
  toolSurface: RuntimeToolSurface;
  provider?: ProviderConfig;
  sessionId?: string;
  sessionData?: unknown;
}

export async function executePhase(
  input: ExecutePhaseInput,
): Promise<PhaseResult & { sessionData?: unknown }> {
  const { ctx, phasePrompt, phaseModel, phase, toolSurface, provider, sessionId, sessionData } = input;

  if (phase.mode === 'map') {
    return runMapPhaseAdapter(input);
  }

  const logger = ctx.options?.logger;
  const runtime = getAgentRuntime(ctx.config.runtime);
  logger?.debug('agent.phase.start', `Phase ${phase.name} starting`, {
    runId: ctx.runId,
    phase: phase.name,
    model: phaseModel,
    maxTurns: phase.maxTurns,
    required: phase.required ?? false,
    toolNames: toolSurface.toolNames ?? null,
    sessionRef: sessionId ?? null,
  });
  try {
    let result;
    try {
      result = await runtime.execute({
        prompt: phasePrompt,
        model: phaseModel,
        maxTurns: phase.maxTurns,
        systemPrompt: ctx.systemPrompt,
        provider,
        sessionRef: sessionId,
        sessionData,
        abortController: ctx.abortController,
        toolSurface,
        logger,
      });
    } catch (error) {
      if (
        !sessionId
        || !runtime.supports('supportsSessionResume')
        || (!isSessionResumeFailure(error) && !isExpiredSessionError(error))
      ) {
        throw error;
      }
      logger?.info('agent.phase.session-retry', `Phase ${phase.name} session failed, retrying without prior session`, {
        runId: ctx.runId,
        phase: phase.name,
        priorSession: sessionId,
        error: toErrorMessage(error),
      });
      result = await runtime.execute({
        prompt: phasePrompt,
        model: phaseModel,
        maxTurns: phase.maxTurns,
        systemPrompt: ctx.systemPrompt,
        provider,
        abortController: ctx.abortController,
        toolSurface,
        logger,
      });
    }

    logger?.debug('agent.phase.end', `Phase ${phase.name} finished`, {
      runId: ctx.runId,
      phase: phase.name,
      status: 'completed',
      turnsUsed: result.turnsUsed,
      maxTurns: phase.maxTurns ?? null,
      tokensUsed: result.usage.totalTokens ?? 0,
      costUsd: result.usage.costUsd ?? null,
    });

    if (phase.required && result.turnsUsed === 0) {
      logger?.warn('agent.phase.zero-turns', `Required phase ${phase.name} produced 0 turns`, {
        runId: ctx.runId,
        phase: phase.name,
      });
    }

    const costData = await resolveCost({
      runtime: ctx.config.runtime,
      provider,
      model: phaseModel,
      usage: result.usage,
    });

    return buildPhaseResult({
      name: phase.name,
      status: 'completed',
      summary: result.finalText,
      usage: result.usage,
      costData,
      sessionRef: result.sessionRef,
      sessionData: result.sessionData,
    });
  } catch (err) {
    const abortReason = abortReasonMessage(ctx.abortController);
    const telemetry = err instanceof RuntimeExecutionError ? err.telemetry : undefined;
    const costData = telemetry
      ? await resolveCost({
          runtime: ctx.config.runtime,
          provider,
          model: phaseModel,
          usage: telemetry.usage,
        })
      : undefined;
    logger?.debug('agent.phase.end', `Phase ${phase.name} failed`, {
      runId: ctx.runId,
      phase: phase.name,
      status: 'failed',
      turnsUsed: telemetry?.usage.requests ?? 0,
      tokensUsed: telemetry?.usage.totalTokens ?? 0,
      costUsd: telemetry?.usage.costUsd ?? null,
      error: abortReason ?? toErrorMessage(err),
    });
    return buildPhaseResult({
      name: phase.name,
      status: 'failed',
      summary: abortReason ? `Error: ${abortReason}` : `Error: ${toErrorMessage(err)}`,
      usage: telemetry?.usage,
      costData,
      sessionRef: telemetry?.sessionRef,
    });
  }
}

// ---------------------------------------------------------------------------
// Map-phase adapter
// ---------------------------------------------------------------------------

async function runMapPhaseAdapter(input: ExecutePhaseInput): Promise<PhaseResult & { sessionData?: unknown }> {
  const { ctx, phase, phaseModel, provider } = input;
  const logger = ctx.options?.logger;
  const runtime = getAgentRuntime(ctx.config.runtime);
  const allTools = createVaultTools(ctx.agentId, ctx.runId, {
    embeddingManager: ctx.embeddingManager,
    projectRoot: ctx.projectRoot,
    vaultDir: ctx.vaultDir,
    dryRun: ctx.options?.dryRun ?? false,
  });

  logger?.debug('agent.map.start', `Map phase "${phase.name}" starting`, {
    runId: ctx.runId, phase: phase.name, model: phaseModel, providerType: provider?.type ?? null,
  });

  try {
    const mapResult = await executeMapPhase({
      phase,
      allTools,
      runtime,
      params: ((ctx.config.taskParams ?? {}) as Record<string, unknown>),
      systemPrompt: ctx.systemPrompt,
      runId: ctx.runId,
      agentId: ctx.agentId,
      phaseModel,
      provider,
      vaultDir: ctx.vaultDir,
      projectRoot: ctx.projectRoot,
      embeddingManager: ctx.embeddingManager,
      logger,
    });
    logger?.debug('agent.map.end', `Map phase "${phase.name}" completed`, {
      runId: ctx.runId, phase: phase.name, ...mapResult,
    });
    return buildPhaseResult({
      name: phase.name,
      status: 'completed',
      summary: `map: written=${mapResult.written} skipped=${mapResult.skipped} failed=${mapResult.failed}`,
      usage: { totalTokens: 0, requests: mapResult.itemCount, costUsd: null } as any,
    });
  } catch (err) {
    const reason = toErrorMessage(err);
    logger?.error('agent.map.error', `Map phase "${phase.name}" threw`, {
      runId: ctx.runId, phase: phase.name, error: reason,
    });
    return buildPhaseResult({
      name: phase.name,
      status: 'failed',
      summary: `Error: ${reason}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Single-query execution (non-phased tasks)
// ---------------------------------------------------------------------------

/**
 * Execute a single `runtime.execute()` call for tasks without a `phases`
 * array. Returns tokens used, cost, and session data for resume support.
 */
export async function executeSingleQuery(
  ctx: PhaseLoopContext,
  taskPrompt: string,
  provider?: ProviderConfig,
  sessionRef?: string,
  sessionData?: unknown,
): Promise<{
  tokensUsed: number;
  costUsd: number | null;
  costData: CostResolution;
  usage: RuntimeUsage;
  sessionRef?: string;
  sessionData?: unknown;
}> {
  const runtime = getAgentRuntime(ctx.config.runtime);
  const effectiveModel = resolveReasoningModel(
    ctx.config.execution?.reasoningLevel ?? ctx.config.reasoningLevel,
    provider,
    ctx.config.model,
  );
  const toolSurface = {
    agentId: ctx.agentId,
    runId: ctx.runId,
    vaultDir: ctx.vaultDir,
    embeddingManager: ctx.embeddingManager,
    dryRun: ctx.config.dryRun ?? false,
  };
  const baseInput = {
    prompt: taskPrompt,
    model: effectiveModel,
    maxTurns: ctx.config.maxTurns,
    systemPrompt: ctx.systemPrompt,
    provider,
    abortController: ctx.abortController,
    toolSurface,
    logger: ctx.options?.logger,
  };
  let result;
  try {
    result = await runtime.execute({ ...baseInput, sessionRef, sessionData });
  } catch (err) {
    // Mirror executePhase's retry: if we had a sessionRef and the runtime
    // supports resume, try once more with a fresh session. Without this,
    // single-query tasks (title-summary, review-session) loop forever in
    // the scheduler whenever their SDK session TTLs out — the caller sees
    // "exited with code 1" and has no way to recover.
    if (
      !sessionRef
      || !runtime.supports('supportsSessionResume')
      || (!isSessionResumeFailure(err) && !isExpiredSessionError(err))
    ) {
      throw err;
    }
    ctx.options?.logger?.info(
      'agent.single-query.session-retry',
      'Single-query session failed, retrying without prior session',
      {
        runId: ctx.runId,
        priorSession: sessionRef,
        error: toErrorMessage(err),
      },
    );
    result = await runtime.execute(baseInput);
  }
  const costData = await resolveCost({
    runtime: ctx.config.runtime,
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
 * Execute a phased task — wave-based parallel `runtime.execute()` calls.
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
export async function executePhasedQuery(
  ctx: PhaseLoopContext,
): Promise<{
  tokensUsed: number;
  costUsd: number | null;
  costData: CostResolution;
  usage: RuntimeUsage;
  phases: PhaseResult[];
}> {
  const { config, systemPrompt, vaultContext, agentId, runId } = ctx;
  const phases = config.phases!;
  const state = ctx.checkpointState;
  const phaseResults: PhaseResult[] = checkpointResultsForResume(config, state);
  let runningTurnCount = phaseResults.reduce((sum, phase) => sum + phase.turnsUsed, 0);
  const completedPhaseNames = new Set(phaseResults.map((phase) => phase.name));

  // -------------------------------------------------------------------------
  // Orchestrator planning (opt-in via config.orchestrator.enabled)
  // -------------------------------------------------------------------------

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
      ctx.taskProviderOverride ?? config.execution?.provider,
      config.model,
    );
    const orchestratorMaxTurns = config.orchestrator.maxTurns ?? DEFAULT_ORCHESTRATOR_MAX_TURNS;
    const runtime = getAgentRuntime(config.runtime);
    const planResponse = await runtime.execute({
      prompt: orchestratorPrompt,
      model: orchestratorModel,
      maxTurns: orchestratorMaxTurns,
      systemPrompt,
      provider: ctx.taskProviderOverride ?? config.execution?.provider,
      toolSurface: {
        agentId,
        runId,
        toolNames: [],
        vaultDir: ctx.vaultDir,
        dryRun: config.dryRun ?? false,
      },
      abortController: ctx.abortController,
      logger: ctx.options?.logger,
    });

    const plan = parseOrchestratorPlan(planResponse.finalText, phases, ctx.options?.logger);
    effectivePhases = applyDirectives(phases, plan.phases);
    ctx.options?.logger?.debug('agent.orchestrator.plan', 'Orchestrator plan applied', {
      runId,
      reasoning: plan.reasoning,
      effectivePhases: effectivePhases.map((p) => p.name),
      skippedPhases: plan.phases.filter((d) => d.skip).map((d) => d.name),
    });
  }

  // -------------------------------------------------------------------------
  // Wave-based phase execution
  // -------------------------------------------------------------------------

  // Build a map from phase name to its YAML declaration order for stable output
  const declarationOrder = new Map(phases.map((p, i) => [p.name, i]));

  const waves = computeWaves(effectivePhases);

  for (const wave of waves) {
    const runnableWave = wave.filter((phase) => !completedPhaseNames.has(phase.name));
    if (runnableWave.length === 0) {
      continue;
    }

    const waveInputs = runnableWave.map((phase, indexInWave) => {
      // Resolve execution config FIRST so the prompt can be templated
      // with the resolved `maxTurns` (and future per-phase runtime
      // knobs). Single canonical precedence resolution — covers run
      // overrides, phase YAML, myco.yaml per-phase overrides, top-level
      // run override, and the task default. See `resolvePhaseExecution`
      // JSDoc for the full precedence table.
      const resolved = resolvePhaseExecution(
        phase,
        ctx.options,
        config,
        ctx.taskProviderOverride ?? config.execution?.provider,
        ctx.phaseProviderOverrides,
      );
      const phaseProvider = resolved.provider;
      const effectiveMaxTurns = resolved.maxTurns;
      const phaseModel = resolved.model;

      const phasePrompt = composePhasePrompt({
        vaultContext,
        taskDisplayName: config.taskDisplayName,
        taskOverview: config.taskPrompt,
        phase,
        priorPhaseResults: phaseResults,
        instruction: ctx.instruction,
        effectiveMaxTurns,
      });
      const existingCheckpoint = state.phases[phase.name];
      // If the prior attempt failed without producing any turns, its sessionRef
      // points at a poisoned/never-initialized SDK session. Re-attaching to it
      // makes the Claude Code subprocess exit 1 immediately, looping forever
      // under scheduled resumes. Generate a fresh session id instead.
      const reuseSession = existingCheckpoint?.sessionRef
        && !(existingCheckpoint.status === 'failed' && (existingCheckpoint.turnsUsed ?? 0) === 0);
      const sessionId = reuseSession
        ? existingCheckpoint!.sessionRef!
        : phaseSessionId(runId, phase.name);
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
          projectRoot: ctx.projectRoot,
          vaultDir: ctx.vaultDir,
          readOnly: phase.readOnly,
          embeddingManager: ctx.embeddingManager,
          dryRun: config.dryRun ?? false,
        },
      };
    });

    if (ctx.persistCheckpoints) {
      await ctx.persistCheckpoints(state, phaseResults);
    }

    const settled = await Promise.allSettled(
      waveInputs.map((waveInput) =>
        executePhase({
          ctx,
          phasePrompt: waveInput.phasePrompt,
          phaseModel: waveInput.phaseModel,
          phase: waveInput.effectivePhase,
          toolSurface: waveInput.toolSurface,
          provider: waveInput.phaseProvider,
          sessionId: waveInput.sessionId,
          sessionData: waveInput.sessionData,
        }),
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

    for (const result of waveResults) {
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

    if (ctx.persistCheckpoints) {
      await ctx.persistCheckpoints(state, phaseResults);
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
