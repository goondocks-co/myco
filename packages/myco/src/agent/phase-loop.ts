/**
 * Phase-loop execution for the agent executor.
 *
 * Extracted from `executor.ts` to keep that file focused on orchestrator-
 * level concerns (run lifecycle, DB bookkeeping, finalization hooks). The
 * functions here own the actual per-phase / per-query dispatch into the
 * harness adapter — `executePhase`, `executeSingleQuery`, and the wave-
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
  planFromStructuredOutput,
  applyDirectives,
  ORCHESTRATOR_PLAN_JSON_SCHEMA,
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
  type RunCheckpointState,
} from './executor-state.js';
import { getAgentHarness } from './harness/index.js';
import { HarnessExecutionError, type HarnessToolSurface } from './harness/types.js';
import type { HarnessHooks, HarnessHookContext } from './harness/hooks.js';
import { composePhasePrompt } from './prompt-composition.js';
import { buildPhaseRecoveryContext } from './phase-recovery.js';
import { resolvePhaseExecution, type MycoYamlPhaseOverrides } from './phase-resolver.js';
import type { CostResolution } from './cost/types.js';
import type { ContextQueryResult } from './context-queries.js';
import type {
  RunOptions,
  EffectiveConfig,
  MapPhaseResult,
  PhaseDefinition,
  PhaseResult,
  ProviderConfig,
  ReasoningLevel,
  RuntimeUsage,
} from './types.js';
import { aggregateUsage } from './executor-state.js';
import { summarizePhaseCosts } from './run-accounting.js';
import { executeMapPhase } from './map-phase.js';
import { createVaultTools } from './tools.js';
import { checkPhasePreCondition } from './phase-preconditions.js';
import { projectScopeFromRequestContext } from '@myco/grove/request-context.js';

/**
 * Pull the cap-hit classification off a caught error. Returns true when
 * the harness adapter (claude.ts / openai.ts) authoritatively classified
 * the error as max-turns at the throw site — adapters know their SDK's
 * error type and don't have to rely on wording match.
 *
 * Non-HarnessExecutionError throws (timeouts, abort, runtime crashes)
 * never classify as cap-hit.
 */
export function isCapHitError(err: unknown): boolean {
  return err instanceof HarnessExecutionError && err.telemetry.kind === 'max-turns';
}

/**
 * Resolve the map phase's terminal status from its result.
 *
 * Three-way contract:
 * - 'skipped'   — a whole-endpoint provider outage with no writes; infra issue,
 *                 NOT a content failure, so a required map phase doesn't fail the run.
 * - 'failed'    — items were fetched but nothing was written and no provider outage;
 *                 every item threw, was rejected, or never reached a terminal tool call.
 *                 Preserves the all-poisoned-batch behavior asserted by phase-loop.test.ts.
 * - 'completed' — at least one item was written, OR the batch was empty.
 */
export function mapResultToPhaseStatus(r: MapPhaseResult): 'completed' | 'failed' | 'skipped' {
  // Provider outage with no writes → skipped (infra; does NOT fail the run).
  if (r.providerUnavailable && r.written === 0) return 'skipped';
  // All-content-failed batch (items fetched, nothing written, no provider outage) → failed.
  if (r.itemCount > 0 && r.written === 0) return 'failed';
  return 'completed';
}

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
  /** Resolved Grove/project request context for in-process vault tool access. */
  readonly requestContext?: RunOptions['requestContext'];
  /** Raw RunOptions — exposed to honor executionOverrides.phases per-phase. */
  readonly options?: RunOptions;
  /** Harness-neutral lifecycle hooks for this run — see agent/harness/hooks.ts. */
  readonly hooks?: HarnessHooks;

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
 * Execute a single phase query through the selected harness adapter.
 *
 * Separated from `executePhasedQuery` so waves can dispatch it via
 * `Promise.allSettled`. Emits a harness retry when session-resume fails
 * against an adapter that advertises `supportsSessionResume`.
 */
export interface ExecutePhaseInput {
  ctx: PhaseLoopContext;
  phasePrompt: string;
  phaseModel: string;
  /** Reasoning tier resolved for this phase by `resolvePhaseExecution`. Forwarded to the harness so it can set a provider-native thinking/reasoning-effort control. */
  reasoningLevel?: ReasoningLevel;
  phase: PhaseDefinition;
  toolSurface: HarnessToolSurface;
  provider?: ProviderConfig;
  sessionId?: string;
  sessionData?: unknown;
  /**
   * Results from earlier waves. Carried here so the cross-phase
   * `gateOnPriorMetadata` check can read upstream metadata before the
   * harness is invoked. (composePhasePrompt also consumes this via the
   * wave loop, but the gate runs before the prompt is composed so it
   * must arrive separately.)
   */
  priorPhaseResults?: PhaseResult[];
}

export async function executePhase(
  input: ExecutePhaseInput,
): Promise<PhaseResult & { sessionData?: unknown }> {
  const { ctx, phasePrompt, phaseModel, reasoningLevel, phase, toolSurface, provider, sessionId, sessionData, priorPhaseResults } = input;

  if (phase.mode === 'map') {
    return runMapPhaseAdapter(input);
  }

  const logger = ctx.options?.logger;

  // Cross-phase skip gate — runs FIRST, before preCondition. Reads the
  // named upstream phase's emitted metadata; skip THIS phase unless the
  // gate value matches. Default-to-skip: missing upstream, missing key,
  // or value mismatch all skip. Zero LLM turns when the gate doesn't
  // match. See PhaseDefinition.gateOnPriorMetadata for the contract.
  if (phase.gateOnPriorMetadata) {
    const gate = phase.gateOnPriorMetadata;
    const upstream = priorPhaseResults?.find((p) => p.name === gate.phase);
    const actual = upstream?.metadata?.[gate.key];
    if (actual !== gate.equals) {
      logger?.info(
        'agent.phase.skip-gate',
        `Phase ${phase.name} skipped: gate "${gate.phase}.${gate.key}" expected ${JSON.stringify(gate.equals)}, got ${actual === undefined ? 'missing' : JSON.stringify(actual)}`,
        {
          runId: ctx.runId,
          phase: phase.name,
          gate,
          actualMissing: actual === undefined,
        },
      );
      return buildPhaseResult({
        name: phase.name,
        status: 'skipped',
        summary: `Skipped (gate "${gate.phase}.${gate.key}" did not match): expected ${JSON.stringify(gate.equals)}, got ${actual === undefined ? 'missing' : JSON.stringify(actual)}`,
      });
    }
  }

  // Mechanical per-phase preCondition. Runs before harness invocation so a
  // false check costs zero LLM turns. Required phases respect the check
  // identically — if the data isn't there, an LLM run can't fabricate it.
  // Counter failure is non-fatal (logged + fall through) so a transient SQL
  // error never stops scheduled work.
  if (phase.preCondition) {
    if (!ctx.requestContext) {
      // The gate requires a project scope to query. A caller that builds
      // a PhaseLoopContext without requestContext (CLI re-run, embedded
      // test harness, future caller) bypasses the gate by necessity —
      // but the bypass is silent without this log. Surfacing it loudly
      // prevents "why did this phase run for $1.50 when there was no
      // work to do" debugging without forensic traces.
      logger?.warn(
        'agent.phase.precondition-no-context',
        `Phase ${phase.name} declares preCondition "${phase.preCondition}" but no requestContext is available — gate bypassed; phase will run at full LLM cost.`,
        {
          runId: ctx.runId,
          phase: phase.name,
          preCondition: phase.preCondition,
        },
      );
    } else {
      try {
        const scope = projectScopeFromRequestContext(ctx.requestContext);
        const result = checkPhasePreCondition(phase.preCondition, scope);
        if (!result.passed) {
          logger?.info('agent.phase.skip-precondition', `Phase ${phase.name} skipped: preCondition not met`, {
            runId: ctx.runId,
            phase: phase.name,
            preCondition: phase.preCondition,
            reason: result.reason,
          });
          return buildPhaseResult({
            name: phase.name,
            status: 'skipped',
            summary: `Skipped (preCondition "${phase.preCondition}"): ${result.reason}`,
          });
        }
      } catch (err) {
        logger?.warn('agent.phase.precondition-error', `Phase ${phase.name} preCondition check threw — proceeding to run`, {
          runId: ctx.runId,
          phase: phase.name,
          preCondition: phase.preCondition,
          error: toErrorMessage(err),
        });
      }
    }
  }

  const harness = getAgentHarness(ctx.config.harness);
  logger?.debug('agent.phase.start', `Phase ${phase.name} starting`, {
    runId: ctx.runId,
    phase: phase.name,
    model: phaseModel,
    maxTurns: phase.maxTurns,
    required: phase.required ?? false,
    toolNames: toolSurface.toolNames ?? null,
    sessionRef: sessionId ?? null,
  });
  const phaseHookStartedAt = Date.now();
  if (ctx.hooks?.phaseStart) {
    try {
      await ctx.hooks.phaseStart({
        runId: ctx.runId,
        agentId: ctx.agentId,
        harnessId: ctx.config.harness,
        phaseName: phase.name,
        model: phaseModel,
        maxTurns: phase.maxTurns,
        required: phase.required ?? false,
      });
    } catch {
      /* hook callbacks are best-effort observability, never fail the phase */
    }
  }
  try {
    let result;
    try {
      result = await harness.execute({
        prompt: phasePrompt,
        model: phaseModel,
        reasoningLevel,
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
        || !harness.supports('supportsSessionResume')
        || harness.classifyError?.(error, { attemptedResume: true }) === 'unknown'
      ) {
        throw error;
      }
      logger?.info('agent.phase.session-retry', `Phase ${phase.name} session failed, retrying without prior session`, {
        runId: ctx.runId,
        phase: phase.name,
        priorSession: sessionId,
        error: toErrorMessage(error),
      });
      result = await harness.execute({
        prompt: phasePrompt,
        model: phaseModel,
        reasoningLevel,
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
      harness: ctx.config.harness,
      provider,
      model: phaseModel,
      usage: result.usage,
    });

    if (ctx.hooks?.phaseEnd) {
      try {
        await ctx.hooks.phaseEnd({
          runId: ctx.runId,
          agentId: ctx.agentId,
          harnessId: ctx.config.harness,
          phaseName: phase.name,
          status: 'completed',
          turnsUsed: result.turnsUsed,
          tokensUsed: result.usage.totalTokens ?? 0,
          costUsd: costData.costUsd,
          durationMs: Date.now() - phaseHookStartedAt,
        });
      } catch {
        /* hook callbacks are best-effort observability */
      }
    }

    return buildPhaseResult({
      name: phase.name,
      status: 'completed',
      summary: result.finalText,
      usage: result.usage,
      costData,
      sessionRef: result.sessionRef,
      sessionData: result.sessionData,
      metadata: snapshotMetadata(toolSurface),
    });
  } catch (err) {
    const abortReason = abortReasonMessage(ctx.abortController);
    const telemetry = err instanceof HarnessExecutionError ? err.telemetry : undefined;
    const errorText = toErrorMessage(err);
    const capHit = isCapHitError(err);
    const costData = telemetry
      ? await resolveCost({
          harness: ctx.config.harness,
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
      capHit,
      allowedMaxTurns: phase.maxTurns ?? null,
      error: abortReason ?? errorText,
    });

    if (ctx.hooks?.phaseEnd) {
      try {
        await ctx.hooks.phaseEnd({
          runId: ctx.runId,
          agentId: ctx.agentId,
          harnessId: ctx.config.harness,
          phaseName: phase.name,
          status: 'failed',
          turnsUsed: telemetry?.usage.requests ?? 0,
          tokensUsed: telemetry?.usage.totalTokens ?? 0,
          costUsd: costData?.costUsd ?? null,
          durationMs: Date.now() - phaseHookStartedAt,
        });
      } catch {
        /* hook callbacks are best-effort observability */
      }
    }

    return buildPhaseResult({
      name: phase.name,
      status: 'failed',
      summary: abortReason ? `Error: ${abortReason}` : `Error: ${errorText}`,
      usage: telemetry?.usage,
      costData,
      sessionRef: telemetry?.sessionRef,
      capHit,
      allowedMaxTurns: phase.maxTurns,
      // Carry over any metadata the phase emitted before the failure —
      // a phase may have committed selectedTier before throwing on a
      // later turn. Downstream gates still see the partial commit.
      metadata: snapshotMetadata(toolSurface),
    });
  }
}

/**
 * Snapshot the per-phase metadata accumulator on the tool surface into a
 * plain object suitable for PhaseResult.metadata. Returns undefined when
 * no accumulator was set up (phase doesn't include `phase_emit_metadata`
 * in its tools list) or no values were committed.
 */
function snapshotMetadata(toolSurface: HarnessToolSurface): Record<string, unknown> | undefined {
  const accumulator = toolSurface.metadataAccumulator;
  if (!accumulator || accumulator.size === 0) return undefined;
  return Object.fromEntries(accumulator);
}

// ---------------------------------------------------------------------------
// Map-phase adapter
// ---------------------------------------------------------------------------

async function runMapPhaseAdapter(input: ExecutePhaseInput): Promise<PhaseResult & { sessionData?: unknown }> {
  const { ctx, phase, phaseModel, reasoningLevel, provider } = input;
  const logger = ctx.options?.logger;
  const harness = getAgentHarness(ctx.config.harness);
  const allTools = createVaultTools(ctx.agentId, ctx.runId, {
    embeddingManager: ctx.embeddingManager,
    projectRoot: ctx.projectRoot,
    vaultDir: ctx.vaultDir,
    requestContext: ctx.requestContext,
    dryRun: ctx.options?.dryRun ?? false,
    hooks: ctx.hooks,
    hookContext: ctx.hooks
      ? { runId: ctx.runId, agentId: ctx.agentId, harnessId: ctx.config.harness, phaseName: phase.name }
      : undefined,
  });

  logger?.debug('agent.map.start', `Map phase "${phase.name}" starting`, {
    runId: ctx.runId, phase: phase.name, model: phaseModel, providerType: provider?.type ?? null,
  });
  const mapHookStartedAt = Date.now();
  if (ctx.hooks?.phaseStart) {
    try {
      await ctx.hooks.phaseStart({
        runId: ctx.runId,
        agentId: ctx.agentId,
        harnessId: ctx.config.harness,
        phaseName: phase.name,
        model: phaseModel ?? '',
        maxTurns: phase.maxTurns,
        required: phase.required ?? false,
      });
    } catch {
      /* hook callbacks are best-effort observability */
    }
  }

  try {
    const mapResult = await executeMapPhase({
      phase,
      allTools,
      harness,
      params: ((ctx.config.taskParams ?? {}) as Record<string, unknown>),
      systemPrompt: ctx.systemPrompt,
      runId: ctx.runId,
      agentId: ctx.agentId,
      phaseModel,
      reasoningLevel,
      provider,
      vaultDir: ctx.vaultDir,
      projectRoot: ctx.projectRoot,
      embeddingManager: ctx.embeddingManager,
      logger,
      runAbortController: ctx.abortController,
    });
    logger?.debug('agent.map.end', `Map phase "${phase.name}" completed`, {
      runId: ctx.runId, phase: phase.name,
      itemCount: mapResult.itemCount,
      written: mapResult.written,
      skipped: mapResult.skipped,
      failed: mapResult.failed,
      tokensUsed: mapResult.usage.totalTokens ?? 0,
      costUsd: mapResult.usage.costUsd ?? null,
    });
    const costData = await resolveCost({
      harness: ctx.config.harness,
      provider,
      model: phaseModel,
      usage: mapResult.usage,
    });
    const writeAfterThrowPart = mapResult.writeAfterThrow > 0
      ? ` writeAfterThrow=${mapResult.writeAfterThrow}`
      : '';
    const phaseStatus = mapResultToPhaseStatus(mapResult);

    if (ctx.hooks?.phaseEnd) {
      try {
        await ctx.hooks.phaseEnd({
          runId: ctx.runId,
          agentId: ctx.agentId,
          harnessId: ctx.config.harness,
          phaseName: phase.name,
          status: phaseStatus,
          turnsUsed: mapResult.usage.requests ?? 0,
          tokensUsed: mapResult.usage.totalTokens ?? 0,
          costUsd: costData.costUsd,
          durationMs: Date.now() - mapHookStartedAt,
        });
      } catch {
        /* hook callbacks are best-effort observability */
      }
    }

    return buildPhaseResult({
      name: phase.name,
      status: phaseStatus,
      summary: phaseStatus === 'skipped'
        ? 'provider unavailable'
        : `map: written=${mapResult.written} skipped=${mapResult.skipped} failed=${mapResult.failed}${writeAfterThrowPart}`,
      usage: mapResult.usage,
      costData,
    });
  } catch (err) {
    const reason = toErrorMessage(err);
    // Same capHit classification as the agent-mode catch — map phases that
    // exhaust their per-item or overall turn budget must surface to the same
    // cost-audit telemetry path. Reads HarnessExecutionError.telemetry.kind
    // set authoritatively at the adapter throw site.
    const capHit = isCapHitError(err);
    const telemetry = err instanceof HarnessExecutionError ? err.telemetry : undefined;
    logger?.error('agent.map.error', `Map phase "${phase.name}" threw`, {
      runId: ctx.runId, phase: phase.name, error: reason, capHit,
      allowedMaxTurns: phase.maxTurns ?? null,
    });

    if (ctx.hooks?.phaseEnd) {
      try {
        await ctx.hooks.phaseEnd({
          runId: ctx.runId,
          agentId: ctx.agentId,
          harnessId: ctx.config.harness,
          phaseName: phase.name,
          status: 'failed',
          turnsUsed: telemetry?.usage.requests ?? 0,
          tokensUsed: telemetry?.usage.totalTokens ?? 0,
          costUsd: null,
          durationMs: Date.now() - mapHookStartedAt,
        });
      } catch {
        /* hook callbacks are best-effort observability */
      }
    }

    return buildPhaseResult({
      name: phase.name,
      status: 'failed',
      summary: `Error: ${reason}`,
      usage: telemetry?.usage,
      sessionRef: telemetry?.sessionRef,
      capHit,
      allowedMaxTurns: phase.maxTurns,
    });
  }
}

// ---------------------------------------------------------------------------
// Single-query execution (non-phased tasks)
// ---------------------------------------------------------------------------

/**
 * Execute a single `harness.execute()` call for tasks without a `phases`
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
  const harness = getAgentHarness(ctx.config.harness);
  const effectiveReasoningLevel = ctx.config.execution?.reasoningLevel ?? ctx.config.reasoningLevel;
  const effectiveModel = resolveReasoningModel(
    effectiveReasoningLevel,
    provider,
    ctx.config.model,
  );
  const toolSurface = {
    agentId: ctx.agentId,
    runId: ctx.runId,
    projectRoot: ctx.projectRoot,
    vaultDir: ctx.vaultDir,
    requestContext: ctx.requestContext,
    embeddingManager: ctx.embeddingManager,
    dryRun: ctx.config.dryRun ?? false,
    hooks: ctx.hooks,
    hookContext: ctx.hooks ? { runId: ctx.runId, agentId: ctx.agentId, harnessId: ctx.config.harness } : undefined,
  };
  const baseInput = {
    prompt: taskPrompt,
    model: effectiveModel,
    reasoningLevel: effectiveReasoningLevel,
    maxTurns: ctx.config.maxTurns,
    systemPrompt: ctx.systemPrompt,
    provider,
    abortController: ctx.abortController,
    toolSurface,
    logger: ctx.options?.logger,
    hooks: ctx.hooks,
  };
  let result;
  try {
    result = await harness.execute({ ...baseInput, sessionRef, sessionData });
  } catch (err) {
    const resumeClassification = harness.classifyError?.(err, { attemptedResume: true });
    // Mirror executePhase's retry: if we had a sessionRef and the harness
    // supports resume, try once more with a fresh session. Without this,
    // single-query tasks (title-summary, review-session) loop forever in
    // the scheduler whenever their SDK session TTLs out — the caller sees
    // "exited with code 1" and has no way to recover.
    if (
      !sessionRef
      || !harness.supports('supportsSessionResume')
      || (
        resumeClassification !== 'session-resume-failed'
        && resumeClassification !== 'session-expired'
      )
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
    result = await harness.execute(baseInput);
  }
  const costData = await resolveCost({
    harness: ctx.config.harness,
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
 * Execute a phased task — wave-based parallel `harness.execute()` calls.
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
  const restoredPhaseNames = new Set(phaseResults.map((phase) => phase.name));
  // Allocation-based audit offsets: the running base advances by each wave's
  // total ALLOCATED turns (sum of resolved maxTurns), never by actual turns
  // used, so every phase owns the same disjoint [offset, offset + maxTurns)
  // turn-index range across fresh runs and resumes — audit indices can
  // never collide.
  let runningTurnCount = 0;
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
      ? await executeContextQueries(agentId, contextQueries, ctx.requestContext)
      : [];

    const orchestratorPrompt = composeOrchestratorPrompt(vaultContext, phases, contextResults);
    const orchestratorReasoningLevel = config.orchestrator.reasoningLevel ?? config.execution?.reasoningLevel ?? config.reasoningLevel;
    const orchestratorModel = config.orchestrator.model ?? resolveReasoningModel(
      orchestratorReasoningLevel,
      ctx.taskProviderOverride ?? config.execution?.provider,
      config.model,
    );
    const orchestratorMaxTurns = config.orchestrator.maxTurns ?? DEFAULT_ORCHESTRATOR_MAX_TURNS;
    const harness = getAgentHarness(config.harness);
    const supportsStructuredOutput = harness.supports('structuredOutput');
    const orchestratorExecuteInput = {
      prompt: orchestratorPrompt,
      model: orchestratorModel,
      reasoningLevel: orchestratorReasoningLevel,
      maxTurns: orchestratorMaxTurns,
      systemPrompt,
      provider: ctx.taskProviderOverride ?? config.execution?.provider,
      toolSurface: {
        agentId,
        runId,
        toolNames: [],
        vaultDir: ctx.vaultDir,
        requestContext: ctx.requestContext,
        dryRun: config.dryRun ?? false,
      },
      abortController: ctx.abortController,
      logger: ctx.options?.logger,
    };

    let planResponse;
    if (supportsStructuredOutput) {
      try {
        planResponse = await harness.execute({
          ...orchestratorExecuteInput,
          outputSchema: { name: 'orchestrator_plan', schema: ORCHESTRATOR_PLAN_JSON_SCHEMA },
        });
        if (planResponse.structuredOutput === undefined) {
          // The call succeeded (no throw) but the provider's structured-output
          // validation failed after its own internal retries — e.g. Claude's
          // error_max_structured_output_retries subtype, which yields an empty
          // finalText and no structured_output on the result message. This is
          // NOT the same path as the catch below (which never had outputSchema
          // attached on its retry, so it can't double-warn here) — surface it
          // so operators can see the schema'd call quietly degraded to the
          // text-parse fallback.
          ctx.options?.logger?.warn(
            'agent.orchestrator.structured-output-missing',
            'Orchestrator structured-output call succeeded but returned no structuredOutput — falling back to text parsing',
            { runId },
          );
        }
      } catch (err) {
        if (ctx.abortController?.signal.aborted) throw err;
        ctx.options?.logger?.warn(
          'agent.orchestrator.structured-output-failed',
          'Orchestrator structured-output request failed — retrying without outputSchema',
          { runId, error: toErrorMessage(err) },
        );
        planResponse = await harness.execute(orchestratorExecuteInput);
      }
    } else {
      planResponse = await harness.execute(orchestratorExecuteInput);
    }

    const plan = planResponse.structuredOutput !== undefined
      ? planFromStructuredOutput(planResponse.structuredOutput, phases, ctx.options?.logger)
      : parseOrchestratorPlan(planResponse.finalText, phases, ctx.options?.logger);
    effectivePhases = applyDirectives(phases, plan.phases, ctx.options?.logger);
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
    // Resolve execution config for EVERY phase in the wave (not just the
    // runnable ones) so each phase's offset is the prefix sum of its
    // preceding siblings' resolved maxTurns — stable across resume, where
    // completed phases are filtered out but still occupy their allocated
    // turn-index range. Single canonical precedence resolution — covers run
    // overrides, phase YAML, myco.yaml per-phase overrides, top-level run
    // override, and the task default. See `resolvePhaseExecution` JSDoc for
    // the full precedence table.
    const resolvedByName = new Map<string, ReturnType<typeof resolvePhaseExecution>>();
    const offsetByName = new Map<string, number>();
    let waveAllocatedTurns = 0;
    for (const phase of wave) {
      const resolved = resolvePhaseExecution(
        phase,
        ctx.options,
        config,
        ctx.taskProviderOverride ?? config.execution?.provider,
        ctx.phaseProviderOverrides,
        ctx.options?.logger,
      );
      resolvedByName.set(phase.name, resolved);
      offsetByName.set(phase.name, runningTurnCount + waveAllocatedTurns);
      waveAllocatedTurns += resolved.maxTurns;
    }

    const runnableWave = wave.filter((phase) => !completedPhaseNames.has(phase.name));
    if (runnableWave.length === 0) {
      runningTurnCount += waveAllocatedTurns;
      continue;
    }

    const waveInputs = runnableWave.map((phase) => {
      const resolved = resolvedByName.get(phase.name)!;
      const phaseProvider = resolved.provider;
      const effectiveMaxTurns = resolved.maxTurns;
      const phaseModel = resolved.model;
      const phaseReasoningLevel = resolved.reasoningLevel;

      const basePhasePrompt = composePhasePrompt({
        vaultContext,
        taskDisplayName: config.taskDisplayName,
        taskOverview: config.taskPrompt,
        phase,
        priorPhaseResults: phaseResults,
        instruction: ctx.instruction,
        effectiveMaxTurns,
        taskParams: config.taskParams,
        runId,
      });
      const recoveryContext = buildPhaseRecoveryContext({
        taskName: config.taskName,
        phaseName: phase.name,
        runId,
        agentId,
        requestContext: ctx.requestContext,
        dryRun: config.dryRun ?? false,
        restoredPhaseNames,
      });
      const phasePrompt = recoveryContext
        ? `${basePhasePrompt}\n\n${recoveryContext}`
        : basePhasePrompt;
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

      // Allocate a per-phase metadata accumulator only when the phase
      // opts in by including `phase_emit_metadata` in its tools list.
      // Absence keeps the toolSurface (and harness adapter chain) shape
      // identical to what existed before this feature — phases that
      // don't emit metadata pay zero overhead.
      const metadataAccumulator = phase.tools?.includes('phase_emit_metadata')
        ? new Map<string, unknown>()
        : undefined;

      return {
        phase,
        phasePrompt,
        phaseModel,
        reasoningLevel: phaseReasoningLevel,
        phaseProvider,
        effectivePhase,
        sessionId,
        sessionData: existingCheckpoint?.sessionData,
        toolSurface: {
          agentId,
          runId,
          toolNames: phase.tools,
          turnOffset: offsetByName.get(phase.name)!,
          projectRoot: ctx.projectRoot,
          vaultDir: ctx.vaultDir,
          requestContext: ctx.requestContext,
          readOnly: phase.readOnly,
          embeddingManager: ctx.embeddingManager,
          dryRun: config.dryRun ?? false,
          metadataAccumulator,
          hooks: ctx.hooks,
          hookContext: ctx.hooks
            ? { runId, agentId, harnessId: config.harness, phaseName: phase.name }
            : undefined,
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
          reasoningLevel: waveInput.reasoningLevel,
          phase: waveInput.effectivePhase,
          toolSurface: waveInput.toolSurface,
          provider: waveInput.phaseProvider,
          sessionId: waveInput.sessionId,
          sessionData: waveInput.sessionData,
          // Carry prior-wave results so executePhase's gateOnPriorMetadata
          // check has visibility into upstream emitted metadata.
          priorPhaseResults: phaseResults,
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
      const checkpointStatus = result.status === 'completed'
        ? 'completed' as const
        : result.status === 'skipped'
          ? 'skipped' as const
          : 'failed' as const;
      state.phases[result.name] = {
        name: result.name,
        status: checkpointStatus,
        summary: result.summary,
        turnsUsed: result.turnsUsed,
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
        costSource: result.costSource,
        costData: result.costData,
        sessionRef: fulfilled?.sessionRef ?? priorCheckpoint?.sessionRef,
        sessionData: fulfilled?.sessionData ?? priorCheckpoint?.sessionData,
        usage: fulfilled?.usage ?? result.usage,
        ...(result.capHit === true ? { capHit: true } : {}),
        ...(result.allowedMaxTurns !== undefined ? { allowedMaxTurns: result.allowedMaxTurns } : {}),
        // Persist cross-phase metadata so a resumed run re-evaluates
        // downstream gates against the SAME upstream commitment, not a
        // re-execution of the upstream phase.
        ...(result.metadata && Object.keys(result.metadata).length > 0
          ? { metadata: result.metadata }
          : {}),
        updatedAt: epochSeconds(),
      };
      // Skipped phases count as satisfied for downstream wave gating —
      // their dependents shouldn't be blocked waiting on a phase that
      // intentionally did nothing.
      if (result.status === 'completed' || result.status === 'skipped') {
        completedPhaseNames.add(result.name);
      }
      phaseResults.push(result);
    }
    runningTurnCount += waveAllocatedTurns;

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

    // Hand control back to libuv between waves. Each wave settles via
    // `Promise.allSettled` (microtasks only) and then writes a
    // checkpoint via sync bun:sqlite — back-to-back waves with no yield
    // can keep the timer/poll phases starved long enough for
    // PowerManager ticks and the `/health` listener to miss their
    // scheduling windows.
    await new Promise<void>((resolve) => setImmediate(resolve));
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
