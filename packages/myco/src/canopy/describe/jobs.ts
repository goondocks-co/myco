/**
 * PowerManager registration for the canopy-describe Tier 2 task.
 *
 * The job ticks on a configurable interval while the daemon is in the
 * idle/sleep states (LLM calls are not appropriate during active user
 * sessions). The actual gating on `cortex.canopy.llm.enabled` lives
 * inside `runCanopyDescribe`, so flipping the toggle in Settings takes
 * effect on the next tick without a daemon restart.
 */

import type { Database } from 'bun:sqlite';
import type { DaemonLogger } from '../../daemon/logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { PowerManager } from '../../daemon/power.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { runCanopyDescribe } from './run.js';

export interface CanopyDescribeJobContext {
  db: Database;
  logger: DaemonLogger;
  /** Stable identifier for canopy_entries.project_id. Matches canopy-scan. */
  projectId: string;
  projectRoot: string;
  liveConfig: { current: MycoConfig };
}

/**
 * Register the canopy-describe PowerManager job. Returns an on-demand
 * runner that bypasses the schedule — used by future UI triggers.
 */
export interface CanopyDescribeJobRegistration {
  /** Manually run a single batch — used for on-demand triggers. */
  runOnce: () => Promise<void>;
}

export function registerCanopyDescribeJob(
  powerManager: PowerManager,
  ctx: CanopyDescribeJobContext,
): CanopyDescribeJobRegistration {
  const tick = async () => {
    try {
      const result = await runCanopyDescribe({
        db: ctx.db,
        projectId: ctx.projectId,
        projectRoot: ctx.projectRoot,
        config: ctx.liveConfig.current,
      });
      if (result.skipped) {
        // Disabled / no-rows / no-provider — silent unless the operator is
        // hunting for it. Emit at debug-level via the same log kind so it
        // shows up in the canopy log filter without spamming info.
        ctx.logger.debug(LOG_KINDS.CANOPY_SCAN, 'Canopy describe skipped', {
          reason: result.skipReason,
        });
        return;
      }
      ctx.logger.info(LOG_KINDS.CANOPY_SCAN, 'Canopy describe batch complete', {
        scanned: result.scanned,
        written: result.written,
        rejected: result.rejected,
        errored: result.errored,
      });
    } catch (err) {
      ctx.logger.error(LOG_KINDS.CANOPY_ERROR, 'Canopy describe job failed', {
        error: (err as Error).message,
      });
    }
  };

  // Run while the daemon is idle/sleep but not deep-sleep. LLM calls during
  // active sessions are wasteful (the user is busy and the model loaded for
  // canopy-describe will steal local-model resources from any agent task).
  powerManager.register({
    name: 'canopy-describe',
    runIn: ['idle', 'sleep'],
    fn: tick,
  });

  return { runOnce: tick };
}
