/**
 * Agent executor.
 *
 * Orchestrates a single agent run:
 *   1. Initializes the database for the vault.
 *   2. Resolves effective config (definition + agent DB overrides + task).
 *   3. Guards against concurrent runs for the same task.
 *   4. Creates or resumes a run record in the database.
 *   5. Builds the task prompt (vault context + task + optional instruction).
 *   6. Executes the selected runtime adapter — single call for flat tasks,
 *      wave-based parallel execution for phased tasks.
 *   7. Persists checkpoint, usage, and resume metadata as the run progresses.
 */

import crypto from 'node:crypto';
import { resolve } from 'node:path';
import { epochSeconds, DEFAULT_AGENT_ID, MS_PER_SECOND, PHASE_SUMMARY_MAX_CHARS } from '@myco/constants.js';
import { errorMessage as toErrorMessage } from '@myco/utils/error-message.js';
import { initDatabase, vaultDbPath } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { getDefaultTask } from '@myco/db/queries/tasks.js';
import {
  insertRun,
  updateRunStatus,
  updateRun,
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
import { computeWaves, phaseSessionId } from './wave-computation.js';
import { SKILL_GENERATE_TASK } from './instruction-builders.js';
import { resolveCost } from './cost/index.js';
import { getAgentRuntime } from './runtime/index.js';
import type { CostResolution, CostSource } from './cost/types.js';
import type { ContextQueryResult } from './context-queries.js';
import type { ProviderConfig } from './types.js';
import type {
  RunOptions,
  AgentRunResult,
  EffectiveConfig,
  PhaseDefinition,
  PhaseResult,
  ProviderType,
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

/** Separator between prompt sections. */
const PROMPT_SECTION_SEPARATOR = '\n\n';

/** Header for prior phase context in phased prompts. */
const PROMPT_SECTION_PRIOR_PHASES = '## Prior Phase Results';

/** Header for the current phase in phased prompts. */
const PROMPT_SECTION_CURRENT_PHASE = '## Current Phase: ';

/** Error patterns that indicate an SDK/runtime session could not be resumed. */
const SESSION_RESUME_ERROR_PATTERNS = [
  /session/,
  /resume/,
  /previous[_ ]response/,
  /conversation/,
];

interface PhaseCheckpoint {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  summary?: string;
  turnsUsed?: number;
  tokensUsed?: number;
  costUsd?: number;
  costSource?: CostSource;
  costData?: CostResolution;
  sessionRef?: string;
  sessionData?: unknown;
  usage?: RuntimeUsage;
  updatedAt: number;
}

interface RunCheckpointState {
  runtime: EffectiveConfig['runtime'];
  provider?: ProviderType;
  model?: string;
  sessionRef?: string;
  sessionData?: unknown;
  phases: Record<string, PhaseCheckpoint>;
}

function abortReasonMessage(abortController?: AbortController): string | null {
  if (!abortController?.signal.aborted) return null;
  const reason = abortController.signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string' && reason.length > 0) return reason;
  return 'Agent run aborted';
}

function isSessionResumeFailure(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return SESSION_RESUME_ERROR_PATTERNS.some((pattern) => pattern.test(message));
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

function parseCheckpointState(raw: string | null | undefined): RunCheckpointState {
  if (!raw) {
    return { runtime: 'claude-sdk', phases: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RunCheckpointState>;
    return {
      runtime: parsed.runtime ?? 'claude-sdk',
      provider: parsed.provider,
      model: parsed.model,
      sessionRef: parsed.sessionRef,
      sessionData: parsed.sessionData,
      phases: parsed.phases ?? {},
    };
  } catch {
    return { runtime: 'claude-sdk', phases: {} };
  }
}

function checkpointResultsForResume(
  config: EffectiveConfig,
  checkpointState: RunCheckpointState,
): PhaseResult[] {
  if (!config.phases) return [];
  const order = new Map(config.phases.map((phase, index) => [phase.name, index]));
  return Object.values(checkpointState.phases)
    .filter((phase) => phase.status === 'completed')
    .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
    .map((phase) => ({
      name: phase.name,
      status: 'completed',
      turnsUsed: phase.turnsUsed ?? 0,
      tokensUsed: phase.tokensUsed ?? 0,
      costUsd: phase.costUsd ?? 0,
      costSource: phase.costSource,
      costData: phase.costData,
      summary: phase.summary ?? '',
      usage: phase.usage,
      sessionRef: phase.sessionRef,
    }));
}

function serializeCheckpointState(state: RunCheckpointState): string {
  return JSON.stringify(state);
}

function aggregateUsage(usages: Array<RuntimeUsage | undefined>): RuntimeUsage {
  const aggregate: RuntimeUsage = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    durationMs: 0,
  };
  let sawCost = false;

  for (const usage of usages) {
    if (!usage) continue;
    aggregate.requests = (aggregate.requests ?? 0) + (usage.requests ?? 0);
    aggregate.inputTokens = (aggregate.inputTokens ?? 0) + (usage.inputTokens ?? 0);
    aggregate.outputTokens = (aggregate.outputTokens ?? 0) + (usage.outputTokens ?? 0);
    aggregate.totalTokens = (aggregate.totalTokens ?? 0) + (usage.totalTokens ?? 0);
    aggregate.reasoningTokens = (aggregate.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
    aggregate.cachedTokens = (aggregate.cachedTokens ?? 0) + (usage.cachedTokens ?? 0);
    aggregate.durationMs = (aggregate.durationMs ?? 0) + (usage.durationMs ?? 0);
    if (usage.costUsd !== undefined && usage.costUsd !== null) {
      aggregate.costUsd = (aggregate.costUsd ?? 0) + usage.costUsd;
      sawCost = true;
    }
  }

  if (!sawCost) {
    delete aggregate.costUsd;
  }

  return aggregate;
}

function buildUsageData(
  runUsage: RuntimeUsage,
  runCost?: CostResolution,
  phaseResults?: PhaseResult[],
): string {
  return JSON.stringify({
    run: runUsage,
    runCost: runCost ?? null,
    phases: phaseResults?.map((phase) => ({
      name: phase.name,
      usage: phase.usage ?? null,
      tokensUsed: phase.tokensUsed,
      costUsd: phase.costUsd,
      costSource: phase.costSource ?? null,
      costData: phase.costData ?? null,
    })) ?? [],
  });
}

function buildActionsTaken(
  runtime: EffectiveConfig['runtime'],
  provider: ProviderConfig | undefined,
  model: string,
  phaseResults?: PhaseResult[],
): string {
  return JSON.stringify({
    runtime,
    model,
    provider: provider?.type ?? 'anthropic',
    ...(provider?.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(phaseResults ? { phases: phaseResults } : {}),
  });
}

function resolveProviderForResume(
  currentProvider: ProviderConfig | undefined,
  resumedRun: ReturnType<typeof getRun>,
  checkpointState: RunCheckpointState,
  runtime: EffectiveConfig['runtime'],
  model: string,
): ProviderConfig | undefined {
  const persistedType = resumedRun?.provider ?? checkpointState.provider;
  if (!persistedType) return currentProvider;
  const matchingCurrentProvider = currentProvider?.type === persistedType ? currentProvider : undefined;

  return {
    ...(matchingCurrentProvider ?? {}),
    runtime,
    type: persistedType,
    model,
  };
}

function serializeCostData(cost: CostResolution | undefined): string | null {
  return cost ? JSON.stringify(cost) : null;
}

function summarizePhaseCosts(phaseResults: PhaseResult[]): CostResolution {
  const costedPhases = phaseResults.filter((phase) => phase.costData && phase.costData.costUsd !== null);
  if (costedPhases.length === 0) {
    return {
      source: 'unavailable',
      costUsd: null,
      actualCostUsd: null,
      estimatedCostUsd: null,
      breakdown: {
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        requestCount: 0,
      },
      pricingVersion: null,
      message: 'No phase cost data available',
    };
  }

  const firstCost = costedPhases[0].costData!;
  const aggregate = {
    costUsd: 0,
    actualCostUsd: 0,
    estimatedCostUsd: 0,
    breakdown: {
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requestCount: 0,
      inputCostUsd: 0,
      cachedInputCostUsd: 0,
      outputCostUsd: 0,
      reasoningCostUsd: 0,
      requestCostUsd: 0,
      cacheSavingsUsd: 0,
      totalCostUsd: 0,
    },
  };

  for (const phase of costedPhases) {
    const cost = phase.costData!;
    const breakdown = cost.breakdown;
    aggregate.costUsd += cost.costUsd ?? 0;
    aggregate.actualCostUsd += cost.actualCostUsd ?? 0;
    aggregate.estimatedCostUsd += cost.estimatedCostUsd ?? 0;
    aggregate.breakdown.inputTokens += breakdown.inputTokens;
    aggregate.breakdown.cachedInputTokens += breakdown.cachedInputTokens;
    aggregate.breakdown.uncachedInputTokens += breakdown.uncachedInputTokens;
    aggregate.breakdown.outputTokens += breakdown.outputTokens;
    aggregate.breakdown.reasoningTokens += breakdown.reasoningTokens;
    aggregate.breakdown.requestCount += breakdown.requestCount;
    aggregate.breakdown.inputCostUsd += breakdown.inputCostUsd ?? 0;
    aggregate.breakdown.cachedInputCostUsd += breakdown.cachedInputCostUsd ?? 0;
    aggregate.breakdown.outputCostUsd += breakdown.outputCostUsd ?? 0;
    aggregate.breakdown.reasoningCostUsd += breakdown.reasoningCostUsd ?? 0;
    aggregate.breakdown.requestCostUsd += breakdown.requestCostUsd ?? 0;
    aggregate.breakdown.cacheSavingsUsd += breakdown.cacheSavingsUsd ?? 0;
  }
  aggregate.breakdown.totalCostUsd = aggregate.costUsd;

  const allActual = phaseResults.every((phase) => phase.costData?.source === 'actual');
  const hasUnavailable = phaseResults.some((phase) => phase.costData?.source === 'unavailable');
  return {
    source: allActual ? 'actual' : 'estimated',
    costUsd: aggregate.costUsd,
    actualCostUsd: allActual ? aggregate.actualCostUsd : null,
    estimatedCostUsd: allActual ? null : aggregate.costUsd,
    breakdown: aggregate.breakdown,
    pricingVersion: costedPhases.every((phase) => phase.costData?.pricingVersion === firstCost.pricingVersion)
      ? firstCost.pricingVersion ?? null
      : null,
    ...(hasUnavailable ? { message: 'Some phase costs were unavailable; total reflects known phase costs only' } : {}),
  };
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
    // 1. Run context queries (if any)
    const contextQueries = config.contextQueries
      ? Object.values(config.contextQueries).flat()
      : [];
    const contextResults: ContextQueryResult[] = contextQueries.length > 0
      ? await executeContextQueries(agentId, contextQueries)
      : [];

    // 2. Compose orchestrator prompt
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
      },
      abortController,
    });

    // 4. Parse plan and apply directives
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

      const phaseOverride = phaseProviderOverrides?.[phase.name];
      const effectiveMaxTurns = phaseOverride?.maxTurns ?? phase.maxTurns;
      const phaseModel = phaseOverride?.model ?? phase.model ?? resolveReasoningModel(
        phase.reasoningLevel ?? config.execution?.reasoningLevel ?? config.reasoningLevel,
        phase.provider ?? phaseOverride?.provider ?? taskProviderOverride ?? config.execution?.provider,
        config.model,
      );
      const phaseProvider = phase.provider ?? phaseOverride?.provider ?? taskProviderOverride ?? config.execution?.provider;
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
  // 1. Init DB (idempotent — returns existing instance if already open)
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

  // 2. Concurrency guard — block duplicate runs of the SAME task, not all tasks.
  // Different tasks (e.g., full-intelligence and skill-generate) can run concurrently.
  // When no task is specified, resolve the effective task name first so the guard applies.
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

  // 3. Resolve config from all sources
  const {
    config,
    definitionsDir,
    taskProviderOverride: resolvedTaskProvider,
    phaseProviderOverrides: resolvedPhaseOverrides,
  } = resolveRunConfig(agentId, requestedTask, vaultDir);

  // Both are mutated by the Ollama variant resolver below — it rewrites
  // provider.model to the variant name and may reconcile context conflicts.
  let taskProviderOverride = resolvedTaskProvider;
  let phaseProviderOverrides = resolvedPhaseOverrides;

  // 4. Create run record
  const runId = options?.resumeRunId ?? crypto.randomUUID();
  const now = epochSeconds();
  let runtimeId = config.runtime;
  const baseProvider = taskProviderOverride ?? config.execution?.provider;
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
    checkpointState.model = effectiveModel;
  } else {
    checkpointState.runtime = checkpointState.runtime ?? runtimeId;
    checkpointState.provider = checkpointState.provider ?? effectiveProvider?.type;
    checkpointState.model = checkpointState.model ?? effectiveModel;
  }

  if (!resumedRun) {
    insertRun({
      id: runId,
      agent_id: agentId,
      task: config.taskName,
      instruction: options?.instruction ?? null,
      status: STATUS_RUNNING,
      runtime: runtimeId,
      provider: effectiveProvider?.type ?? null,
      model: effectiveModel,
      checkpoints: serializeCheckpointState(checkpointState),
      usage_data: buildUsageData({}),
      started_at: now,
    });
  } else {
    updateRun(runId, {
      status: STATUS_RUNNING,
      runtime: runtimeId,
      provider: effectiveProvider?.type ?? resumedRun.provider ?? null,
      model: effectiveModel,
      started_at: now,
      completed_at: null,
      resumable: 0,
      resume_status: null,
      resume_mode: options?.resumeMode ?? resumedRun.resume_mode ?? null,
      resumed_at: now,
      checkpoints: serializeCheckpointState(checkpointState),
      usage_data: resumedRun.usage_data,
      cost_usd: resumedRun.cost_usd,
      actual_cost_usd: resumedRun.actual_cost_usd,
      estimated_cost_usd: resumedRun.estimated_cost_usd,
      cost_source: resumedRun.cost_source,
      cost_data: resumedRun.cost_data,
      error: null,
    });
  }

  // 5. Build prompt components
  const systemPrompt = loadSystemPrompt(definitionsDir, config.systemPromptPath);
  const vaultContext = buildVaultContext(agentId);

  // 7. Resolve Ollama context variants across task + phase scopes.
  //    Applies DEFAULT_OLLAMA_CONTEXT_LENGTH when no value is set, and
  //    reconciles same-model-different-context conflicts to one variant
  //    per model (max wins) so Ollama loads each model at most once.
  //    Non-ollama providers are passed through unchanged.
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

  // 8. Execute — phased or single query
  // Create abort controller for task-level timeout enforcement
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
      await Promise.resolve(updateRun(runId, {
        runtime: runtimeId,
        provider: effectiveProvider?.type ?? null,
        model: effectiveModel,
        session_ref: currentCheckpointState.sessionRef ?? null,
        checkpoints: serializeCheckpointState(currentCheckpointState),
        usage_data: buildUsageData(currentUsage, currentCost, currentPhaseResults),
        cost_usd: currentCost.costUsd ?? null,
        actual_cost_usd: currentCost.actualCostUsd,
        estimated_cost_usd: currentCost.estimatedCostUsd,
        cost_source: currentCost.source,
        cost_data: serializeCostData(currentCost),
        actions_taken: buildActionsTaken(runtimeId, effectiveProvider, effectiveModel, currentPhaseResults),
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
    }

    clearTimeout(timeoutId);
    const completedAt = epochSeconds();
    updateRunStatus(runId, STATUS_COMPLETED, {
      runtime: runtimeId,
      provider: effectiveProvider?.type ?? null,
      model: effectiveModel,
      session_ref: runSessionRef ?? null,
      resumable: 0,
      resume_status: null,
      completed_at: completedAt,
      tokens_used: tokensUsed,
      cost_usd: costData.costUsd ?? null,
      actual_cost_usd: costData.actualCostUsd,
      estimated_cost_usd: costData.estimatedCostUsd,
      cost_source: costData.source,
      cost_data: serializeCostData(costData),
      checkpoints: serializeCheckpointState(checkpointState),
      usage_data: buildUsageData(usage, costData, phaseResults),
      actions_taken: buildActionsTaken(runtimeId, effectiveProvider, effectiveModel, phaseResults),
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
    // 7. Error handling — mark run as failed, preserve phase results
    // Aggressively extract error info — the SDK may throw non-Error objects
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
      const costData = phaseResults ? summarizePhaseCosts(phaseResults) : await resolveCost({
        runtime: runtimeId,
        provider: effectiveProvider,
        model: effectiveModel,
        usage,
      });
      updateRunStatus(runId, STATUS_FAILED, {
        runtime: runtimeId,
        provider: effectiveProvider?.type ?? null,
        model: effectiveModel,
        session_ref: checkpointState.sessionRef ?? null,
        resumable: 1,
        resume_status: RESUME_STATUS_READY,
        checkpoints: serializeCheckpointState(checkpointState),
        usage_data: buildUsageData(usage, costData, phaseResults),
        completed_at: failedAt,
        tokens_used: usage.totalTokens ?? phaseResults?.reduce((sum, phase) => sum + phase.tokensUsed, 0) ?? undefined,
        cost_usd: costData.costUsd ?? null,
        actual_cost_usd: costData.actualCostUsd,
        estimated_cost_usd: costData.estimatedCostUsd,
        cost_source: costData.source,
        cost_data: serializeCostData(costData),
        error: errorMessage,
        actions_taken: buildActionsTaken(runtimeId, effectiveProvider, effectiveModel, phaseResults),
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
