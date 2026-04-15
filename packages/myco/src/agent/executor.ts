/**
 * Agent executor.
 *
 * Orchestrates a single agent run:
 *   1. Initializes the database for the vault.
 *   2. Resolves effective config (definition + agent DB overrides + task).
 *   3. Guards against concurrent runs for the same agent.
 *   4. Creates a run record in the database.
 *   5. Builds the task prompt (vault context + task + optional instruction).
 *   6. Executes the Claude Agent SDK query — single call for flat tasks,
 *      wave-based parallel execution for phased tasks.
 *   7. Records cost/token data and marks the run completed or failed.
 */

import crypto from 'node:crypto';
import { resolve } from 'node:path';
import { epochSeconds, DEFAULT_AGENT_ID, MS_PER_SECOND, PHASE_SUMMARY_MAX_CHARS } from '@myco/constants.js';
import { errorMessage as toErrorMessage } from '@myco/utils/error-message.js';
import { initDatabase, vaultDbPath, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { getDefaultTask } from '@myco/db/queries/tasks.js';
import {
  insertRun,
  updateRunStatus,
  getRunningRunForTask,
  STATUS_RUNNING,
  STATUS_COMPLETED,
  STATUS_FAILED,
} from '@myco/db/queries/runs.js';
import { loadSystemPrompt } from './loader.js';
import { createVaultToolServer, createScopedVaultToolServer } from './tools.js';
import { buildVaultContext } from './context.js';
import { composeOrchestratorPrompt, parseOrchestratorPlan, applyDirectives, DEFAULT_ORCHESTRATOR_MAX_TURNS } from './orchestrator.js';
import { executeContextQueries } from './context-queries.js';
import { buildPhaseEnv } from './provider.js';
import { resolveRunConfig } from './config-resolver.js';
import { resolveOllamaContextVariants } from './ollama-context.js';
import { computeWaves, phaseSessionId } from './wave-computation.js';
import { SKILL_GENERATE_TASK } from './instruction-builders.js';
import type { ContextQueryResult } from './context-queries.js';
import type { ProviderConfig } from './types.js';
import type {
  RunOptions,
  AgentRunResult,
  EffectiveConfig,
  PhaseDefinition,
  PhaseResult,
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

/** MCP server name for the vault tool server. */
const MCP_SERVER_NAME = 'myco-vault';

/** Whether to persist the agent session to disk. */
const PERSIST_SESSION = true;

/** Header for prior phase context in phased prompts. */
const PROMPT_SECTION_PRIOR_PHASES = '## Prior Phase Results';

/** Header for the current phase in phased prompts. */
const PROMPT_SECTION_CURRENT_PHASE = '## Current Phase: ';

// ---------------------------------------------------------------------------
// Per-turn tool-call debug logging
// ---------------------------------------------------------------------------
//
// When MYCO_AGENT_DEBUG=1, every tool_use and tool_result inside a phase is
// logged to stdout with a short input/output preview. This is intended for
// diagnosing turn-budget exhaustion: it surfaces rejection loops, malformed
// tool-call retries, and unexpected exploration that the per-phase
// `num_turns` summary alone cannot explain.
//
// The daemon sets this env var automatically when log_level is "debug"
// (see src/daemon/main.ts). It can also be set manually for ad-hoc runs.

/** Max chars to print from tool input/output payloads. */
const TOOL_DEBUG_PREVIEW_CHARS = 240;

function debugToolCallsEnabled(): boolean {
  return process.env.MYCO_AGENT_DEBUG === '1';
}

interface SdkContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface SdkMessageWithContent {
  message?: { content?: SdkContentBlock[] };
}

function previewPayload(value: unknown): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str === undefined) return '';
  return str.length > TOOL_DEBUG_PREVIEW_CHARS
    ? `${str.slice(0, TOOL_DEBUG_PREVIEW_CHARS)}…(${str.length - TOOL_DEBUG_PREVIEW_CHARS} more chars)`
    : str;
}

function logToolUseBlocks(phaseName: string, message: unknown): void {
  if (!debugToolCallsEnabled()) return;
  const blocks = (message as SdkMessageWithContent).message?.content;
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      console.log(
        `[agent:debug] ${phaseName} tool_use: ${block.name ?? 'unknown'} input=${previewPayload(block.input)}`,
      );
    }
  }
}

function logToolResultBlocks(phaseName: string, message: unknown): void {
  if (!debugToolCallsEnabled()) return;
  const blocks = (message as SdkMessageWithContent).message?.content;
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const flag = block.is_error ? ' [ERROR]' : '';
      console.log(
        `[agent:debug] ${phaseName} tool_result${flag}: ${previewPayload(block.content)}`,
      );
    }
  }
}

function abortReasonMessage(abortController?: AbortController): string | null {
  if (!abortController?.signal.aborted) return null;
  const reason = abortController.signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string' && reason.length > 0) return reason;
  return 'Agent run aborted';
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
 * Execute a single phase query.
 *
 * Isolated helper that runs one query() call with scoped tools,
 * provider env, and phase-specific config.
 */
async function executePhase(
  query: typeof import('@anthropic-ai/claude-agent-sdk').query,
  phasePrompt: string,
  phaseModel: string,
  systemPrompt: string,
  toolServer: ReturnType<typeof createScopedVaultToolServer>,
  phase: PhaseDefinition,
  env: Record<string, string | undefined> | undefined,
  sessionId?: string,
  abortController?: AbortController,
): Promise<PhaseResult> {
  let phaseCost = 0;
  let phaseTokens = 0;
  let phaseTurns = 0;
  let agenticTurns = 0;
  let phaseSummary = '';

  try {
    for await (const message of query({
      prompt: phasePrompt,
      options: {
        model: phaseModel,
        systemPrompt,
        mcpServers: { [MCP_SERVER_NAME]: toolServer },
        strictMcpConfig: true,
        maxTurns: phase.maxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: PERSIST_SESSION,
        env,
        tools: [],
        ...(sessionId ? { sessionId } : {}),
        ...(abortController ? { abortController } : {}),
      },
    })) {
      if (message.type === 'assistant') {
        agenticTurns++;
        logToolUseBlocks(phase.name, message);
      }
      if (message.type === 'user') {
        logToolResultBlocks(phase.name, message);
      }
      if (message.type === 'result') {
        phaseCost = message.total_cost_usd ?? 0;
        phaseTokens =
          (message.usage.input_tokens ?? 0) + (message.usage.output_tokens ?? 0);
        phaseTurns = message.num_turns ?? 0;
        if ('result' in message && typeof message.result === 'string') {
          phaseSummary = message.result;
        }
      }
    }

    if (phase.maxTurns) {
      console.log(
        `[agent] Phase "${phase.name}": num_turns=${phaseTurns}, assistant_msgs=${agenticTurns}, budget=${phase.maxTurns}`,
      );
    }

    if (phase.required && phaseTurns === 0) {
      console.warn(`[agent] Required phase "${phase.name}" produced 0 turns`);
    }

    // Use SDK's num_turns — it's what the SDK enforces against.
    // agenticTurns (assistant message count) is logged for diagnostics
    // but not reliable as the primary metric.
    return {
      name: phase.name,
      status: 'completed',
      turnsUsed: phaseTurns,
      tokensUsed: phaseTokens,
      costUsd: phaseCost,
      summary: phaseSummary,
    };
  } catch (err) {
    const abortReason = abortReasonMessage(abortController);
    return {
      name: phase.name,
      status: 'failed',
      turnsUsed: phaseTurns,
      tokensUsed: phaseTokens,
      costUsd: phaseCost,
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
): Promise<{ tokensUsed: number; costUsd: number }> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const toolServer = createVaultToolServer(agentId, runId, { embeddingManager, vaultDir });
  const baseEnv = buildPhaseEnv(provider);
  const env = { ...(baseEnv ?? process.env), MYCO_AGENT_SESSION: '1' };
  // Model priority: provider model override → task YAML model
  const effectiveModel = provider?.model ?? config.model;

  let resultCostUsd = 0;
  let resultTokens = 0;

  for await (const message of query({
    prompt: taskPrompt,
    options: {
      model: effectiveModel,
      systemPrompt,
      mcpServers: { [MCP_SERVER_NAME]: toolServer },
      strictMcpConfig: true,
      maxTurns: config.maxTurns,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: PERSIST_SESSION,
      env,
      tools: [],
      ...(abortController ? { abortController } : {}),
    },
  })) {
    if (message.type === 'result') {
      resultCostUsd = message.total_cost_usd ?? 0;
      resultTokens =
        (message.usage.input_tokens ?? 0) + (message.usage.output_tokens ?? 0);
    }
  }

  return { tokensUsed: resultTokens, costUsd: resultCostUsd };
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
  phaseProviderOverrides?: Record<string, { provider?: ProviderConfig; maxTurns?: number }>,
  instruction?: string,
  embeddingManager?: RunOptions['embeddingManager'],
  abortController?: AbortController,
  projectRoot?: string,
  vaultDir?: string,
): Promise<{ tokensUsed: number; costUsd: number; phases: PhaseResult[] }> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const phases = config.phases!;
  const phaseResults: PhaseResult[] = [];
  let totalTokens = 0;
  let totalCost = 0;
  let runningTurnCount = 0;

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
    const orchestratorModel = config.orchestrator.model ?? config.model;
    const orchestratorMaxTurns = config.orchestrator.maxTurns ?? DEFAULT_ORCHESTRATOR_MAX_TURNS;

    // 3. Call orchestrator (no tools — planning only)
    const orchestratorEnv = { ...(buildPhaseEnv(taskProviderOverride) ?? process.env), MYCO_AGENT_SESSION: '1' };
    let planResponse = '';
    for await (const message of query({
      prompt: orchestratorPrompt,
      options: {
        model: orchestratorModel,
        maxTurns: orchestratorMaxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: PERSIST_SESSION,
        strictMcpConfig: true,
        env: orchestratorEnv,
        tools: [],
      },
    })) {
      if (message.type === 'result' && 'result' in message && typeof message.result === 'string') {
        planResponse = message.result;
      }
    }

    // 4. Parse plan and apply directives
    const plan = parseOrchestratorPlan(planResponse, phases);
    effectivePhases = applyDirectives(phases, plan.phases);
  }

  // ---------------------------------------------------------------------------
  // Wave-based phase execution
  // ---------------------------------------------------------------------------

  // Build a map from phase name to its YAML declaration order for stable output
  const declarationOrder = new Map(phases.map((p, i) => [p.name, i]));

  const waves = computeWaves(effectivePhases);

  for (const wave of waves) {
    const executions = wave.map((phase, indexInWave) => {
      const phasePrompt = composePhasePrompt(
        vaultContext,
        config.taskDisplayName,
        config.taskPrompt,
        phase,
        phaseResults,
        instruction,
      );

      // Apply myco.yaml per-phase overrides (maxTurns, provider)
      const phaseOverride = phaseProviderOverrides?.[phase.name];
      const effectiveMaxTurns = phaseOverride?.maxTurns ?? phase.maxTurns;

      // Model priority: phase YAML → myco.yaml phase provider → myco.yaml task provider → task YAML
      const phaseModel = phase.model ?? phaseOverride?.provider?.model ?? taskProviderOverride?.model ?? config.model;
      const toolServer = createScopedVaultToolServer(
        agentId,
        runId,
        phase.tools,
        {
          turnOffset: runningTurnCount + (indexInWave * effectiveMaxTurns),
          embeddingManager,
          projectRoot,
          vaultDir,
          readOnly: phase.readOnly,
        },
      );

      // Provider priority: phase YAML → myco.yaml phase → myco.yaml task → task YAML execution → default
      const phaseProvider = phase.provider ?? phaseOverride?.provider ?? taskProviderOverride ?? config.execution?.provider;
      const baseEnv = buildPhaseEnv(phaseProvider);
      const env = { ...(baseEnv ?? process.env), MYCO_AGENT_SESSION: '1' };
      const sessionId = phaseSessionId(runId, phase.name);

      // Pass effective maxTurns to executePhase via a modified phase object
      const effectivePhase = effectiveMaxTurns !== phase.maxTurns
        ? { ...phase, maxTurns: effectiveMaxTurns }
        : phase;

      return executePhase(query, phasePrompt, phaseModel, systemPrompt, toolServer, effectivePhase, env, sessionId, abortController);
    });

    const settled = await Promise.allSettled(executions);

    // Map settled results to PhaseResult[]
    const waveResults: PhaseResult[] = settled.map((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        return outcome.value;
      }
      // Promise.allSettled rejected — shouldn't happen since executePhase catches,
      // but handle defensively
      return {
        name: wave[i].name,
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

    // Accumulate results and totals
    for (const result of waveResults) {
      phaseResults.push(result);
      totalTokens += result.tokensUsed;
      totalCost += result.costUsd;
      runningTurnCount += result.turnsUsed;
    }

    // If any required phase in this wave failed, stop the pipeline
    const shouldStop = wave.some((phase, i) => {
      if (!phase.required) return false;
      const outcome = settled[i];
      if (outcome.status === 'rejected') return true;
      return outcome.value.status === 'failed';
    });

    if (shouldStop) {
      break;
    }
  }

  return { tokensUsed: totalTokens, costUsd: totalCost, phases: phaseResults };
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

  // 2. Concurrency guard — block duplicate runs of the SAME task, not all tasks.
  // Different tasks (e.g., full-intelligence and skill-generate) can run concurrently.
  // When no task is specified, resolve the effective task name first so the guard applies.
  const requestedTask = options?.task;
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

  if (!options?.resumeRunId) {
    insertRun({
      id: runId,
      agent_id: agentId,
      task: config.taskName,
      instruction: options?.instruction ?? null,
      status: STATUS_RUNNING,
      started_at: now,
    });
  }

  // 5. Build prompt components
  const systemPrompt = loadSystemPrompt(definitionsDir, config.systemPromptPath);
  const vaultContext = buildVaultContext(agentId);

  // 6. Build run metadata for audit trail
  const effectiveProvider = taskProviderOverride ?? config.execution?.provider;
  const effectiveModel = effectiveProvider?.model ?? config.model;
  const runMeta = {
    model: effectiveModel,
    provider: effectiveProvider?.type ?? 'anthropic',
    ...(effectiveProvider?.baseUrl ? { baseUrl: effectiveProvider.baseUrl } : {}),
  };

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
    let costUsd: number;

    if (config.phases && config.phases.length > 0) {
      // Phased execution: wave-based parallel query() per phase with scoped tools
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
      );
      tokensUsed = result.tokensUsed;
      costUsd = result.costUsd;
      phaseResults = result.phases;

      // A required-phase failure stops the pipeline (executePhasedQuery breaks
      // the wave loop) but returns normally. Surface it as a run-level failure
      // by throwing — the catch block writes STATUS_FAILED while preserving
      // the accumulated phase results in the DB row.
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
      );
      tokensUsed = result.tokensUsed;
      costUsd = result.costUsd;
    }

    clearTimeout(timeoutId);
    const completedAt = epochSeconds();
    updateRunStatus(runId, STATUS_COMPLETED, {
      completed_at: completedAt,
      tokens_used: tokensUsed,
      cost_usd: costUsd,
      actions_taken: JSON.stringify({ ...runMeta, ...(phaseResults ? { phases: phaseResults } : {}) }),
    });

    return {
      runId,
      status: STATUS_COMPLETED,
      tokensUsed,
      costUsd,
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
      updateRunStatus(runId, STATUS_FAILED, {
        completed_at: failedAt,
        error: errorMessage,
        // Preserve phase results collected before the failure
        actions_taken: JSON.stringify({ ...runMeta, ...(phaseResults ? { phases: phaseResults } : {}) }),
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
