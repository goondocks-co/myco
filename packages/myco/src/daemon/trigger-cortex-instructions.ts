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
}

export interface TriggerCortexInstructionsResult {
  started: boolean;
  reason?: 'event-tasks-disabled' | 'provider-not-configured' | 'agent-module-unavailable';
  runId?: string | null;
}

export async function triggerCortexInstructions(
  deps: TriggerCortexInstructionsDeps,
): Promise<TriggerCortexInstructionsResult> {
  const { vaultDir, embeddingManager, liveConfig, logger, getTeamClient } = deps;
  const config = liveConfig.current;

  if (config.agent.event_tasks_enabled === false) {
    return { started: false, reason: 'event-tasks-disabled' };
  }
  if (!hasConfiguredProvider(config, 'cortex-instructions')) {
    return { started: false, reason: 'provider-not-configured' };
  }

  try {
    const { runAgent } = await import('../agent/executor.js');
    const built = await buildCortexInstructionsInput(config, getTeamClient);
    const resultPromise = runAgent(vaultDir, {
      task: 'cortex-instructions',
      agentId: DEFAULT_AGENT_ID,
      instruction: built.instruction,
      runContext: { cortex_instruction_input_hash: built.inputHash },
      embeddingManager,
    });
    const runId = getLatestRunId(DEFAULT_AGENT_ID, 'cortex-instructions');

    resultPromise.catch((err) => {
      logger.warn(LOG_KINDS.AGENT_ERROR, 'Cortex instructions task failed', {
        error: String(err),
        run_id: runId ?? undefined,
      });
    });

    return { started: true, runId };
  } catch {
    return { started: false, reason: 'agent-module-unavailable' };
  }
}
