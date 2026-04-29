/**
 * Cortex orchestration module.
 *
 * Owns the daemon-side Cortex entry points:
 *   - Prompt builder (`buildCortexPrompt`) — fires a prompt-builder agent run
 *     and returns a summary of the stored Cortex instruction state.
 *   - Snapshot accessor (`getCortexInstructionsSnapshot`) — synchronous read
 *     over the cortex_instructions DB row.
 *   - Prompt result accessor (`getCortexPromptResult`) — reads the stored run
 *     for the prompt-builder task.
 *   - Instructions refresh trigger (`triggerCortexInstructions`) —
 *     fire-and-forget launcher for the scheduled "refresh Cortex
 *     session-start instructions" agent task. Shared by the Cortex page's
 *     manual refresh and any future event-driven callers.
 *
 * Content assembly (capabilities, retrieval guidance, instruction input
 * prompt) lives in `@myco/context/cortex-brief`. This module is strictly
 * the orchestration layer: deciding which symbiont is targeted, what
 * instructions go inline, and how the agent run is launched + tracked.
 */
import { runAgent } from '@myco/agent/executor.js';
import { hasConfiguredProvider } from '@myco/agent/config-resolver.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import {
  buildCortexInstructionsInput,
  resolveInstructionDelivery,
} from '@myco/context/cortex-brief.js';
import { getCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import { listReports, type ReportRow } from '@myco/db/queries/reports.js';
import { getLatestRunId, getRun } from '@myco/db/queries/runs.js';
import { tryParseJson } from '@myco/utils/json.js';
import { listSymbiontInfos, type SymbiontInfo } from './api/symbionts.js';
import type { EmbeddingManager } from './embedding/manager.js';
import type { DaemonLogger } from './logger.js';
import type { TeamSyncClient } from './team-sync.js';

export const CORTEX_PROMPT_BUILDER_TASK = 'cortex-prompt-builder';
const CORTEX_INSTRUCTIONS_TASK = 'cortex-instructions';
const JSON_INDENT = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Dependencies for `buildCortexPrompt` / `getCortexInstructionsSnapshot`
 * call sites. Config is pre-resolved because the caller (the HTTP handler)
 * snapshots it per-request.
 */
export interface CortexServicesDeps {
  config: MycoConfig;
  embeddingManager?: EmbeddingManager;
  getTeamClient?: () => TeamSyncClient | null;
  logger: DaemonLogger;
  /** Optional registry that tracks the fire-and-forget run so daemon shutdown can await it. */
  registerInflightRun?: (promise: Promise<unknown>) => void;
}

/**
 * Dependencies for `triggerCortexInstructions`. Takes a live config holder
 * (not a snapshot) because the trigger is invoked from background contexts
 * where the config may change between calls.
 */
export interface TriggerCortexInstructionsDeps {
  vaultDir: string;
  embeddingManager: EmbeddingManager;
  liveConfig: { current: MycoConfig };
  logger: DaemonLogger;
  getTeamClient?: () => TeamSyncClient | null;
  /** Optional registry that tracks the fire-and-forget run so daemon shutdown can await it. */
  registerInflightRun?: (promise: Promise<unknown>) => void;
  /**
   * Dynamic import seam for the agent executor. Defaults to the real import
   * so tests can force the module-unavailable branch without monkey-patching
   * the module system.
   */
  loadExecutor?: () => Promise<typeof import('../agent/executor.js')>;
}

export interface CortexInstructionsSnapshot {
  content: string;
  generatedAt: number | null;
  sourceRunId: string | null;
  enabled: boolean;
  stored: boolean;
}

export interface CortexPromptBuilderResult {
  runId: string;
  status: string;
  prompt: string;
  reports: Array<{
    id: number;
    action: string;
    summary: string;
    created_at: number;
  }>;
  error?: string | null;
}

export interface CortexPromptBuilderStartResult {
  started: boolean;
  runId: string | null;
  inlineInstructions: boolean;
  targetSymbiont: SymbiontInfo | null;
}

export interface TriggerCortexInstructionsResult {
  started: boolean;
  reason?:
    | 'event-tasks-disabled'
    | 'provider-not-configured'
    | 'agent-module-unavailable'
    | 'startup-failed';
  runId?: string | null;
  error?: string;
}

interface CortexPromptBuilderDetails {
  prompt?: string;
}

function isCortexPromptBuilderDetails(value: unknown): value is CortexPromptBuilderDetails {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getLatestReportForAction(runId: string, action: string): ReportRow | undefined {
  const reports = listReports(runId);
  for (let i = reports.length - 1; i >= 0; i -= 1) {
    if (reports[i]?.action === action) return reports[i];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Snapshot + result readers
// ---------------------------------------------------------------------------

export function getCortexInstructionsSnapshot(
  config: Pick<MycoConfig, 'cortex'>,
): CortexInstructionsSnapshot {
  const row = getCortexInstructions(DEFAULT_AGENT_ID);

  return {
    content: row?.content ?? '',
    generatedAt: row?.generated_at ?? null,
    sourceRunId: row?.source_run_id ?? null,
    enabled: config.cortex.enabled && config.cortex.instructions.inject_on_session_start,
    stored: Boolean(row),
  };
}

function resolvePromptBuilderSymbiont(vaultDir: string, requestedName?: string): SymbiontInfo | null {
  const enabledSymbionts = listSymbiontInfos(vaultDir).filter((symbiont) => symbiont.enabled);
  if (enabledSymbionts.length === 0) return null;
  if (!requestedName) return enabledSymbionts[0] ?? null;
  return enabledSymbionts.find((symbiont) => symbiont.name === requestedName) ?? null;
}

// ---------------------------------------------------------------------------
// Prompt builder launcher
// ---------------------------------------------------------------------------

export async function buildCortexPrompt(
  vaultDir: string,
  deps: CortexServicesDeps,
  goal: string,
  requestedSymbiont?: string,
): Promise<CortexPromptBuilderStartResult> {
  const targetSymbiont = resolvePromptBuilderSymbiont(vaultDir, requestedSymbiont);
  const delivery = resolveInstructionDelivery(deps.config.cortex, targetSymbiont);
  const instructions = delivery.inlineInstructions
    ? getCortexInstructions(DEFAULT_AGENT_ID)
    : null;

  const builderInstruction = [
    `Goal:\n${goal.trim()}`,
    '',
    '## Target symbiont',
    JSON.stringify(
      targetSymbiont
        ? {
            name: targetSymbiont.name,
            displayName: targetSymbiont.displayName,
            supportsSessionStartInjection: targetSymbiont.supportsSessionStartInjection,
            supportsPromptSubmitInjection: targetSymbiont.supportsPromptSubmitInjection,
          }
        : null,
      null,
      JSON_INDENT,
    ),
    '',
    '## Delivery contract',
    JSON.stringify(
      {
        inline_instructions: delivery.inlineInstructions,
        reason: delivery.reason,
      },
      null,
      JSON_INDENT,
    ),
    '',
    delivery.inlineInstructions
      ? [
          '## Current Cortex session-start instructions',
          instructions?.content || 'No current Cortex instructions are available.',
          '',
        ].join('\n')
      : '## Current Cortex session-start instructions\nOmit them from the prompt because this symbiont receives session-start injection.\n',
  ].join('\n');

  const resultPromise = runAgent(vaultDir, {
    task: CORTEX_PROMPT_BUILDER_TASK,
    agentId: DEFAULT_AGENT_ID,
    instruction: builderInstruction,
    embeddingManager: deps.embeddingManager,
    logger: deps.logger,
  });
  const runId = getLatestRunId(DEFAULT_AGENT_ID, CORTEX_PROMPT_BUILDER_TASK);
  const tracked = resultPromise.catch((err) => {
    deps.logger.warn(LOG_KINDS.AGENT_ERROR, 'cortex-prompt-builder task failed', {
      run_id: runId ?? undefined,
      error: String(err),
    });
  });
  deps.registerInflightRun?.(tracked);

  return {
    started: true,
    runId,
    inlineInstructions: delivery.inlineInstructions,
    targetSymbiont,
  };
}

export function getCortexPromptResult(runId: string): CortexPromptBuilderResult | null {
  const run = getRun(runId);
  if (!run) return null;

  const reports = listReports(runId);
  const promptReport = getLatestReportForAction(runId, 'cortex_prompt_builder');
  const details = tryParseJson(promptReport?.details, isCortexPromptBuilderDetails);

  return {
    runId,
    status: run.status,
    prompt: details?.prompt ?? '',
    reports: reports.map((report) => ({
      id: report.id,
      action: report.action,
      summary: report.summary,
      created_at: report.created_at,
    })),
    error: run.error,
  };
}

// ---------------------------------------------------------------------------
// Fire-and-forget trigger for the cortex-instructions task
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget trigger for the Cortex instructions agent task.
 *
 * Shared by the Cortex page's manual refresh action and any future
 * event-driven callers. The scheduler owns the periodic path; this helper
 * owns the explicit "run now" path without inventing a third mechanism.
 */
export async function triggerCortexInstructions(
  deps: TriggerCortexInstructionsDeps,
): Promise<TriggerCortexInstructionsResult> {
  const { vaultDir, embeddingManager, liveConfig, logger, getTeamClient } = deps;
  const loadExecutor = deps.loadExecutor ?? (() => import('../agent/executor.js'));
  const config = liveConfig.current;

  if (config.agent.event_tasks_enabled === false) {
    return { started: false, reason: 'event-tasks-disabled' };
  }
  if (!hasConfiguredProvider(config, CORTEX_INSTRUCTIONS_TASK)) {
    return { started: false, reason: 'provider-not-configured' };
  }

  let runAgentFn: typeof import('../agent/executor.js').runAgent;
  try {
    ({ runAgent: runAgentFn } = await loadExecutor());
  } catch (err) {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'cortex-instructions: agent module unavailable', {
      error: String(err),
    });
    return {
      started: false,
      reason: 'agent-module-unavailable',
      error: String(err),
    };
  }

  try {
    const built = await buildCortexInstructionsInput(config, vaultDir, getTeamClient);
    const resultPromise = runAgentFn(vaultDir, {
      task: CORTEX_INSTRUCTIONS_TASK,
      agentId: DEFAULT_AGENT_ID,
      instruction: built.instruction,
      runContext: { cortex_instruction_input_hash: built.inputHash },
      embeddingManager,
    });
    const runId = getLatestRunId(DEFAULT_AGENT_ID, CORTEX_INSTRUCTIONS_TASK);

    const tracked = resultPromise.catch((err) => {
      logger.warn(LOG_KINDS.AGENT_ERROR, 'Cortex instructions task failed', {
        error: String(err),
        run_id: runId ?? undefined,
      });
    });
    deps.registerInflightRun?.(tracked);

    return { started: true, runId };
  } catch (err) {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Failed to start cortex-instructions task', {
      error: String(err),
    });
    return {
      started: false,
      reason: 'startup-failed',
      error: String(err),
    };
  }
}
