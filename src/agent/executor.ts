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
 *      sequential phase loop for phased tasks.
 *   7. Records cost/token data and marks the run completed or failed.
 */

import crypto from 'node:crypto';
import { epochSeconds, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { initDatabaseForVault } from '@myco/db/client.js';
import { getAgent } from '@myco/db/queries/agents.js';
import { getTask, getDefaultTask } from '@myco/db/queries/tasks.js';
import {
  insertRun,
  updateRunStatus,
  getRunningRun,
  STATUS_RUNNING,
  STATUS_COMPLETED,
  STATUS_FAILED,
} from '@myco/db/queries/runs.js';
import {
  resolveDefinitionsDir,
  loadAgentDefinition,
  loadSystemPrompt,
  resolveEffectiveConfig,
} from './loader.js';
import { loadAllTasks } from './registry.js';
import { createVaultToolServer, createScopedVaultToolServer } from './tools.js';
import { buildVaultContext } from './context.js';
import { composeOrchestratorPrompt, parseOrchestratorPlan, applyDirectives, DEFAULT_ORCHESTRATOR_MAX_TURNS } from './orchestrator.js';
import { executeContextQueries } from './context-queries.js';
import { applyProviderEnv, restoreProviderEnv } from './provider.js';
import type { ContextQueryResult } from './context-queries.js';
import type {
  RunOptions,
  AgentRunResult,
  EffectiveConfig,
  PhaseDefinition,
  PhaseResult,
} from './types.js';

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
const PERSIST_SESSION = false;

/** Header for prior phase context in phased prompts. */
const PROMPT_SECTION_PRIOR_PHASES = '## Prior Phase Results';

/** Header for the current phase in phased prompts. */
const PROMPT_SECTION_CURRENT_PHASE = '## Current Phase: ';

/** Truncation limit for phase summary text passed to subsequent phases. */
const PHASE_SUMMARY_MAX_CHARS = 2000;

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

  // Include prior phase results as context
  if (priorPhaseResults.length > 0) {
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
): Promise<{ tokensUsed: number; costUsd: number }> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const toolServer = createVaultToolServer(agentId, runId);

  let resultCostUsd = 0;
  let resultTokens = 0;

  for await (const message of query({
    prompt: taskPrompt,
    options: {
      model: config.model,
      systemPrompt,
      mcpServers: { [MCP_SERVER_NAME]: toolServer },
      maxTurns: config.maxTurns,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: PERSIST_SESSION,
      tools: [],
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
// Phased execution
// ---------------------------------------------------------------------------

/**
 * Execute a phased task — sequential query() calls, one per phase.
 *
 * Each phase gets:
 * - Scoped tools (only the tools listed in the phase definition)
 * - Its own turn budget (maxTurns)
 * - Optional model override (falls back to task/agent model)
 * - Context from prior phase results
 *
 * The executor controls the loop — the LLM cannot skip phases.
 */
async function executePhasedQuery(
  config: EffectiveConfig,
  systemPrompt: string,
  vaultContext: string,
  agentId: string,
  runId: string,
  instruction?: string,
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
    let planResponse = '';
    for await (const message of query({
      prompt: orchestratorPrompt,
      options: {
        model: orchestratorModel,
        maxTurns: orchestratorMaxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: PERSIST_SESSION,
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
  // Phase loop
  // ---------------------------------------------------------------------------

  for (const phase of effectivePhases) {
    const phasePrompt = composePhasePrompt(
      vaultContext,
      config.taskDisplayName,
      config.taskPrompt,
      phase,
      phaseResults,
      instruction,
    );

    const phaseModel = phase.model ?? config.model;
    const toolServer = createScopedVaultToolServer(agentId, runId, phase.tools, runningTurnCount);

    let phaseCost = 0;
    let phaseTokens = 0;
    let phaseTurns = 0;
    let phaseSummary = '';

    // Apply provider env for this phase (if execution.provider is configured)
    const phaseProvider = config.execution?.provider;
    const savedEnv = phaseProvider ? applyProviderEnv(phaseProvider) : null;

    try {
      for await (const message of query({
        prompt: phasePrompt,
        options: {
          model: phaseModel,
          systemPrompt,
          mcpServers: { [MCP_SERVER_NAME]: toolServer },
          maxTurns: phase.maxTurns,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          persistSession: PERSIST_SESSION,
          tools: [],
        },
      })) {
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

      if (phase.required && phaseTurns === 0) {
        console.warn(`[agent] Required phase "${phase.name}" produced 0 turns`);
      }

      phaseResults.push({
        name: phase.name,
        status: 'completed',
        turnsUsed: phaseTurns,
        tokensUsed: phaseTokens,
        costUsd: phaseCost,
        summary: phaseSummary,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      phaseResults.push({
        name: phase.name,
        status: 'failed',
        turnsUsed: phaseTurns,
        tokensUsed: phaseTokens,
        costUsd: phaseCost,
        summary: `Error: ${errorMessage}`,
      });

      // If a required phase fails, stop the pipeline.
      // finally runs before break, so provider env is always restored.
      if (phase.required) {
        break;
      }
    } finally {
      // Always restore provider env after each phase query (including on break).
      if (savedEnv) restoreProviderEnv(savedEnv);
      // Accumulate totals and advance turn count (runs even on break).
      totalTokens += phaseTokens;
      totalCost += phaseCost;
      runningTurnCount += phaseTurns;
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
 * For tasks with a `phases` array, uses phased execution (sequential query()
 * calls per phase with scoped tools). For tasks without phases, uses a single
 * query() call as before.
 *
 * @param vaultDir — absolute path to the vault directory.
 * @param options — optional overrides for agent, task, and instruction.
 * @returns the run result with status, token usage, and cost.
 */
export async function runAgent(
  vaultDir: string,
  options?: RunOptions,
): Promise<AgentRunResult> {
  // 1. Init DB
  await initDatabaseForVault(vaultDir);

  const agentId = options?.agentId ?? DEFAULT_AGENT_ID;

  // 2. Concurrency guard — check before expensive config loading
  const running = await getRunningRun(agentId);
  if (running) {
    return {
      runId: running.id,
      status: STATUS_SKIPPED,
      reason: SKIP_REASON_ALREADY_RUNNING,
    };
  }

  // 3. Resolve config
  const definitionsDir = resolveDefinitionsDir();
  const definition = loadAgentDefinition(definitionsDir);

  // Load agent and task in parallel — both are independent DB lookups
  const taskPromise = options?.task
    ? getTask(options.task)
    : getDefaultTask(agentId);

  const [agentRow, taskRow] = await Promise.all([
    getAgent(agentId),
    taskPromise,
  ]);

  // Structural fields (phases, execution, contextQueries) come from the registry
  // (built-in YAML merged with user vault tasks) rather than the DB flat columns.
  const allTasks = loadAllTasks(definitionsDir, vaultDir);
  const taskName = taskRow?.id ?? options?.task;
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
        ...(yamlTask?.phases ? { phases: yamlTask.phases } : {}),
        ...(yamlTask?.execution ? { execution: yamlTask.execution } : {}),
        ...(yamlTask?.contextQueries ? { contextQueries: yamlTask.contextQueries } : {}),
        ...(yamlTask?.orchestrator ? { orchestrator: yamlTask.orchestrator } : {}),
      }
    : undefined;

  const config = resolveEffectiveConfig(definition, agentRow, taskOverrides);

  // 4. Create run record
  const runId = crypto.randomUUID();
  const now = epochSeconds();

  await insertRun({
    id: runId,
    agent_id: agentId,
    task: config.taskName,
    instruction: options?.instruction ?? null,
    status: STATUS_RUNNING,
    started_at: now,
  });

  // 5. Build prompt components
  const systemPrompt = loadSystemPrompt(definitionsDir, config.systemPromptPath);
  const vaultContext = await buildVaultContext(agentId);

  // 6. Execute — phased or single query
  let phaseResults: PhaseResult[] | undefined;
  try {
    let tokensUsed: number;
    let costUsd: number;

    if (config.phases && config.phases.length > 0) {
      // Phased execution: sequential query() per phase with scoped tools
      const result = await executePhasedQuery(
        config,
        systemPrompt,
        vaultContext,
        agentId,
        runId,
        options?.instruction,
      );
      tokensUsed = result.tokensUsed;
      costUsd = result.costUsd;
      phaseResults = result.phases;
    } else {
      // Single-query execution (backward compatible)
      const taskPrompt = composeTaskPrompt(
        vaultContext,
        config.taskDisplayName,
        config.taskPrompt,
        options?.instruction,
      );
      const result = await executeSingleQuery(
        config,
        systemPrompt,
        taskPrompt,
        agentId,
        runId,
      );
      tokensUsed = result.tokensUsed;
      costUsd = result.costUsd;
    }

    const completedAt = epochSeconds();
    await updateRunStatus(runId, STATUS_COMPLETED, {
      completed_at: completedAt,
      tokens_used: tokensUsed,
      cost_usd: costUsd,
      actions_taken: phaseResults ? JSON.stringify({ phases: phaseResults }) : undefined,
    });

    return {
      runId,
      status: STATUS_COMPLETED,
      tokensUsed,
      costUsd,
      ...(phaseResults ? { phases: phaseResults } : {}),
    };
  } catch (err) {
    // 7. Error handling — mark run as failed, preserve phase results
    const errorMessage = err instanceof Error
      ? err.message || err.constructor.name
      : String(err) || 'Unknown error';
    const failedAt = epochSeconds();

    console.error(`[agent] Run ${runId} failed:`, errorMessage);
    if (err instanceof Error && err.stack) {
      console.error(`[agent] Stack:`, err.stack);
    }

    try {
      await updateRunStatus(runId, STATUS_FAILED, {
        completed_at: failedAt,
        error: errorMessage,
        // Preserve phase results collected before the failure
        actions_taken: phaseResults ? JSON.stringify({ phases: phaseResults }) : undefined,
      });
    } catch {
      // DB failure in error path — do not mask the original error
    }

    return {
      runId,
      status: STATUS_FAILED,
      error: errorMessage,
      ...(phaseResults ? { phases: phaseResults } : {}),
    };
  }
}
