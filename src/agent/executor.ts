/**
 * Curation agent executor.
 *
 * Orchestrates a single agent run:
 *   1. Initializes the database for the vault.
 *   2. Resolves effective config (definition + curator DB overrides + task).
 *   3. Guards against concurrent runs for the same curator.
 *   4. Creates a run record in the database.
 *   5. Builds the task prompt (vault context + task + optional instruction).
 *   6. Executes the Claude Agent SDK query with an in-process MCP tool server.
 *   7. Records cost/token data and marks the run completed or failed.
 */

import crypto from 'node:crypto';
import { epochSeconds, DEFAULT_CURATOR_ID } from '@myco/constants.js';
import { initDatabaseForVault } from '@myco/db/client.js';
import { getCurator } from '@myco/db/queries/curators.js';
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
import { createVaultToolServer } from './tools.js';
import { buildVaultContext } from './context.js';
import type { RunOptions, AgentRunResult } from './types.js';

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

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

/**
 * Build the full task prompt from vault context, task definition, and
 * optional user instruction.
 */
export function composeTaskPrompt(
  vaultContext: string,
  taskDisplayName: string,
  taskPrompt: string,
  instruction?: string,
): string {
  const parts = [
    vaultContext,
    `${PROMPT_SECTION_TASK}${taskDisplayName}\n${taskPrompt}`,
  ];

  if (instruction) {
    parts.push(`${PROMPT_SECTION_INSTRUCTION}\n${instruction}`);
  }

  return parts.join(PROMPT_SECTION_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a curation agent against a vault.
 *
 * @param vaultDir — absolute path to the vault directory.
 * @param options — optional overrides for curator, task, and instruction.
 * @returns the run result with status, token usage, and cost.
 */
export async function runCurationAgent(
  vaultDir: string,
  options?: RunOptions,
): Promise<AgentRunResult> {
  // 1. Init DB
  await initDatabaseForVault(vaultDir);

  // 2. Resolve config
  const definitionsDir = resolveDefinitionsDir();
  const definition = loadAgentDefinition(definitionsDir);

  const curatorId = options?.curatorId ?? DEFAULT_CURATOR_ID;

  // Load curator and task in parallel — both are independent DB lookups
  const taskPromise = options?.task
    ? getTask(options.task)
    : getDefaultTask(curatorId);

  const [curatorRow, taskRow] = await Promise.all([
    getCurator(curatorId),
    taskPromise,
  ]);

  // Convert TaskRow to AgentTask shape for resolveEffectiveConfig
  const taskOverrides = taskRow
    ? {
        name: taskRow.id,
        displayName: taskRow.display_name ?? taskRow.id,
        description: taskRow.description ?? '',
        agent: taskRow.curator_id,
        prompt: taskRow.prompt,
        isDefault: taskRow.is_default === 1,
        ...(taskRow.tool_overrides
          ? { toolOverrides: JSON.parse(taskRow.tool_overrides) as string[] }
          : {}),
      }
    : undefined;

  const config = resolveEffectiveConfig(definition, curatorRow, taskOverrides);

  // 3. Concurrency guard
  const running = await getRunningRun(curatorId);
  if (running) {
    return {
      runId: running.id,
      status: STATUS_SKIPPED,
      reason: SKIP_REASON_ALREADY_RUNNING,
    };
  }

  // 4. Create run record
  const runId = crypto.randomUUID();
  const now = epochSeconds();

  await insertRun({
    id: runId,
    curator_id: curatorId,
    task: config.taskName,
    instruction: options?.instruction ?? null,
    status: STATUS_RUNNING,
    started_at: now,
  });

  // 5. Build prompt
  const systemPrompt = loadSystemPrompt(definitionsDir, config.systemPromptPath);
  const vaultContext = await buildVaultContext(curatorId);
  const taskPrompt = composeTaskPrompt(
    vaultContext,
    config.taskDisplayName,
    config.taskPrompt,
    options?.instruction,
  );

  // 6. Create tool server
  const toolServer = createVaultToolServer(curatorId, runId);

  // 7. Execute Agent SDK
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

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

    const completedAt = epochSeconds();
    await updateRunStatus(runId, STATUS_COMPLETED, {
      completed_at: completedAt,
      tokens_used: resultTokens,
      cost_usd: resultCostUsd,
    });

    return {
      runId,
      status: STATUS_COMPLETED,
      tokensUsed: resultTokens,
      costUsd: resultCostUsd,
    };
  } catch (err) {
    // 8. Error handling — mark run as failed
    const errorMessage = err instanceof Error ? err.message : String(err);
    const failedAt = epochSeconds();

    try {
      await updateRunStatus(runId, STATUS_FAILED, {
        completed_at: failedAt,
        error: errorMessage,
      });
    } catch {
      // DB failure in error path — do not mask the original error
    }

    return {
      runId,
      status: STATUS_FAILED,
      error: errorMessage,
    };
  }
}
