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
import { epochSeconds, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { errorMessage as toErrorMessage } from '@myco/utils/error-message.js';
import { initDatabase, vaultDbPath } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
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
import { buildPhaseEnv } from './provider.js';
import { loadConfig } from '@myco/config/loader.js';
import type { ContextQueryResult } from './context-queries.js';
import type { ProviderConfig } from './types.js';
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
const PERSIST_SESSION = true;

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
// Ollama model pre-loading
// ---------------------------------------------------------------------------

/** Timeout for Ollama model pre-load request (ms). */
const OLLAMA_PRELOAD_TIMEOUT_MS = 30_000;

/**
 * Ensure an Ollama model variant exists with the desired context length.
 *
 * The Anthropic-compatible endpoint (/v1/messages) always loads models at
 * default context — it ignores /api/chat preloads and API-created params.
 * The only reliable way is `ollama create` with a Modelfile containing
 * `PARAMETER num_ctx`. Creates a variant named `{model}-ctx{contextLength}`.
 *
 * Returns the variant model name to use.
 */
async function ensureOllamaContextVariant(
  model: string,
  contextLength: number,
): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const baseName = model.replace(/:latest$/, '');
  const variantName = `${baseName}-ctx${contextLength}`;

  try {
    // Check if variant already exists
    execFileSync('ollama', ['show', variantName], { stdio: 'ignore' });
    return variantName;
  } catch {
    // Doesn't exist — create it
  }

  try {
    const modelfilePath = join(tmpdir(), `myco-modelfile-${Date.now()}`);
    writeFileSync(modelfilePath, `FROM ${model}\nPARAMETER num_ctx ${contextLength}\n`);
    execFileSync('ollama', ['create', variantName, '-f', modelfilePath], {
      stdio: 'ignore',
      timeout: OLLAMA_PRELOAD_TIMEOUT_MS,
    });
    try { unlinkSync(modelfilePath); } catch { /* cleanup best-effort */ }
    return variantName;
  } catch {
    return model; // Fall back to original
  }
}

// ---------------------------------------------------------------------------
// Wave computation (Kahn's algorithm)
// ---------------------------------------------------------------------------

/**
 * Compute execution waves from phase dependency graph.
 *
 * Uses Kahn's algorithm to topologically sort phases into waves.
 * Phases in the same wave have no dependencies on each other and
 * can execute in parallel via Promise.allSettled().
 *
 * @throws Error if circular dependencies are detected.
 */
export function computeWaves(phases: PhaseDefinition[]): PhaseDefinition[][] {
  const nameToPhase = new Map(phases.map(p => [p.name, p]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dependency → phases that depend on it

  // Initialize
  for (const phase of phases) {
    inDegree.set(phase.name, 0);
    dependents.set(phase.name, []);
  }

  // Build adjacency — skip dependencies on phases not in the set
  // (they may have been removed by orchestrator directives)
  for (const phase of phases) {
    const deps = phase.dependsOn ?? [];
    for (const dep of deps) {
      if (!nameToPhase.has(dep)) continue; // skipped/removed phase — treat as satisfied
      inDegree.set(phase.name, (inDegree.get(phase.name) ?? 0) + 1);
      dependents.get(dep)!.push(phase.name);
    }
  }

  // Collect waves
  const waves: PhaseDefinition[][] = [];
  const completed = new Set<string>();

  while (completed.size < phases.length) {
    // Find all phases with zero unsatisfied deps
    const wave: PhaseDefinition[] = [];
    for (const phase of phases) {
      if (completed.has(phase.name)) continue;
      if ((inDegree.get(phase.name) ?? 0) === 0) {
        wave.push(phase);
      }
    }

    if (wave.length === 0) {
      const remaining = phases.filter(p => !completed.has(p.name)).map(p => p.name);
      throw new Error(`Circular dependency detected among phases: ${remaining.join(', ')}`);
    }

    waves.push(wave);

    // Mark wave as completed and decrement dependents' in-degrees
    for (const phase of wave) {
      completed.add(phase.name);
      for (const dependent of (dependents.get(phase.name) ?? [])) {
        inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);
      }
    }
  }

  return waves;
}

// ---------------------------------------------------------------------------
// Session ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic session ID (UUID format) for a phase.
 * Derived from run ID + phase name so the same run always produces
 * the same session IDs.
 */
function phaseSessionId(runId: string, phaseName: string): string {
  const hash = crypto.createHash('sha256').update(`${runId}-${phaseName}`).digest('hex');
  // Format as UUID: 8-4-4-4-12
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
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
): Promise<PhaseResult> {
  let phaseCost = 0;
  let phaseTokens = 0;
  let phaseTurns = 0;
  let phaseSummary = '';

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
        env,
        tools: [],
        ...(sessionId ? { sessionId } : {}),
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

    return {
      name: phase.name,
      status: 'completed',
      turnsUsed: phaseTurns,
      tokensUsed: phaseTokens,
      costUsd: phaseCost,
      summary: phaseSummary,
    };
  } catch (err) {
    return {
      name: phase.name,
      status: 'failed',
      turnsUsed: phaseTurns,
      tokensUsed: phaseTokens,
      costUsd: phaseCost,
      summary: `Error: ${toErrorMessage(err)}`,
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
): Promise<{ tokensUsed: number; costUsd: number }> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const toolServer = createVaultToolServer(agentId, runId, embeddingManager);
  const env = buildPhaseEnv(provider);
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
      maxTurns: config.maxTurns,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: PERSIST_SESSION,
      env,
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
        runningTurnCount + (indexInWave * effectiveMaxTurns),
        embeddingManager,
      );

      // Provider priority: phase YAML → myco.yaml phase → myco.yaml task → task YAML execution → default
      const phaseProvider = phase.provider ?? phaseOverride?.provider ?? taskProviderOverride ?? config.execution?.provider;
      const env = buildPhaseEnv(phaseProvider);
      const sessionId = phaseSessionId(runId, phase.name);

      // Pass effective maxTurns to executePhase via a modified phase object
      const effectivePhase = effectiveMaxTurns !== phase.maxTurns
        ? { ...phase, maxTurns: effectiveMaxTurns }
        : phase;

      return executePhase(query, phasePrompt, phaseModel, systemPrompt, toolServer, effectivePhase, env, sessionId);
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

  // 2. Concurrency guard — check before expensive config loading
  const running = getRunningRun(agentId);
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

  // Load agent and task — both are sync DB lookups
  const agentRow = getAgent(agentId);
  const taskRow = options?.task
    ? getTask(options.task)
    : getDefaultTask(agentId);

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

  // Load myco.yaml for provider overrides (global, per-task, per-phase)
  let taskProviderOverride: ProviderConfig | undefined;
  let phaseProviderOverrides: Record<string, { provider?: ProviderConfig; maxTurns?: number }> = {};
  try {
    const mycoConfig = loadConfig(vaultDir);

    // Helper to convert myco.yaml snake_case provider to runtime camelCase
    // API keys are NOT stored in myco.yaml — they flow via env vars (settings.json → hooks → daemon)
    const toProviderConfig = (p: { type: 'cloud' | 'ollama' | 'lmstudio'; base_url?: string; model?: string; context_length?: number }): ProviderConfig => ({
      type: p.type, baseUrl: p.base_url, model: p.model, contextLength: p.context_length,
    });

    // Per-task override takes priority over global
    const taskConfig = taskName ? mycoConfig.agent.tasks?.[taskName] : undefined;
    const globalProvider = mycoConfig.agent.provider;

    if (taskConfig?.provider) {
      taskProviderOverride = toProviderConfig(taskConfig.provider);
    } else if (globalProvider) {
      taskProviderOverride = toProviderConfig(globalProvider);
    }

    // Per-phase overrides from myco.yaml
    if (taskConfig?.phases) {
      for (const [phaseName, phaseConfig] of Object.entries(taskConfig.phases)) {
        phaseProviderOverrides[phaseName] = {
          ...(phaseConfig.provider ? { provider: toProviderConfig(phaseConfig.provider) } : {}),
          ...(phaseConfig.maxTurns != null ? { maxTurns: phaseConfig.maxTurns } : {}),
        };
      }
    }
  } catch {
    // Config load failure is non-fatal — proceed without overrides
  }

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
    provider: effectiveProvider?.type ?? 'cloud',
    ...(effectiveProvider?.baseUrl ? { baseUrl: effectiveProvider.baseUrl } : {}),
  };

  // 7. Ensure Ollama model has correct context length (creates variant if needed)
  if (effectiveProvider?.type === 'ollama' && effectiveProvider.contextLength && effectiveProvider.model) {
    const variantModel = await ensureOllamaContextVariant(
      effectiveProvider.model,
      effectiveProvider.contextLength,
    );
    // Override the model name so the SDK uses the context-aware variant
    taskProviderOverride = { ...taskProviderOverride!, model: variantModel };
  }

  // 8. Execute — phased or single query
  let phaseResults: PhaseResult[] | undefined;
  try {
    let tokensUsed: number;
    let costUsd: number;

    if (config.phases && config.phases.length > 0) {
      // Phased execution: wave-based parallel query() per phase with scoped tools
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
      );
      tokensUsed = result.tokensUsed;
      costUsd = result.costUsd;
    }

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

    return {
      runId,
      status: STATUS_FAILED,
      error: errorMessage,
      ...(phaseResults ? { phases: phaseResults } : {}),
    };
  }
}
