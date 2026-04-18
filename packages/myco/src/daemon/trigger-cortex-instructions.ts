/**
 * Fire-and-forget trigger for the Cortex instructions agent task.
 *
 * Shared by the Cortex page's manual refresh action and any future
 * event-driven callers. The scheduler owns the periodic path; this helper
 * owns the explicit "run now" path without inventing a third mechanism.
 */

import type { EmbeddingManager } from './embedding/manager.js';
import type { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { getLatestRunId } from '@myco/db/queries/runs.js';
import { hasConfiguredProvider } from '@myco/agent/config-resolver.js';
import type { TeamSyncClient } from './team-sync.js';
import { buildCortexInstructionsInput } from '@myco/cortex/instructions-input.js';

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

export async function triggerCortexInstructions(
  deps: TriggerCortexInstructionsDeps,
): Promise<TriggerCortexInstructionsResult> {
  const { vaultDir, embeddingManager, liveConfig, logger, getTeamClient } = deps;
  const loadExecutor = deps.loadExecutor ?? (() => import('../agent/executor.js'));
  const config = liveConfig.current;

  if (config.agent.event_tasks_enabled === false) {
    return { started: false, reason: 'event-tasks-disabled' };
  }
  if (!hasConfiguredProvider(config, 'cortex-instructions')) {
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
    const built = await buildCortexInstructionsInput(config, getTeamClient);
    const resultPromise = runAgentFn(vaultDir, {
      task: 'cortex-instructions',
      agentId: DEFAULT_AGENT_ID,
      instruction: built.instruction,
      runContext: { cortex_instruction_input_hash: built.inputHash },
      embeddingManager,
    });
    const runId = getLatestRunId(DEFAULT_AGENT_ID, 'cortex-instructions');

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
