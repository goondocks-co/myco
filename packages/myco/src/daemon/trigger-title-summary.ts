/**
 * Fire-and-forget trigger for the title-summary agent task.
 *
 * Shared between the Stop-hook pipeline (per-session activity) and the
 * manual "Complete Session" API (user-initiated regenerate). Both paths
 * need the same config gates and the same dynamic-import guard against a
 * missing agent module; sharing avoids drift when either concern changes.
 */

import type { EmbeddingManager } from './embedding/manager.js';
import type { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

export interface TriggerTitleSummaryDeps {
  vaultDir: string;
  embeddingManager: EmbeddingManager;
  config: MycoConfig;
  logger: DaemonLogger;
}

/**
 * Trigger `title-summary` for one session.
 *
 * Returns without scheduling a run when:
 * - `agent.summary_batch_interval <= 0` (summaries disabled entirely), or
 * - `agent.event_tasks_enabled === false` (event-driven tasks globally off), or
 * - the agent module can't be loaded.
 *
 * Rejections from the executor surface via `logger.warn` — the task's own
 * per-task concurrency guard handles overlap with in-flight runs.
 */
export async function triggerTitleSummary(
  sessionId: string,
  deps: TriggerTitleSummaryDeps,
): Promise<void> {
  const { vaultDir, embeddingManager, config, logger } = deps;

  if (config.agent.summary_batch_interval <= 0) return;
  if (config.agent.event_tasks_enabled === false) return;

  try {
    const { runAgent } = await import('../agent/executor.js');
    runAgent(vaultDir, {
      task: 'title-summary',
      instruction: `Process session ${sessionId} only`,
      embeddingManager,
    }).catch((err) => {
      logger.warn(LOG_KINDS.AGENT_ERROR, 'Title-summary task failed', {
        session_id: sessionId,
        error: String(err),
      });
    });
  } catch {
    // agent module unavailable — silently no-op
  }
}
