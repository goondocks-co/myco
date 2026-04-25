import type { Database } from 'bun:sqlite';
import type { DaemonLogger } from '../logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { PowerManager } from '../power.js';
import { scanProject } from '@myco/canopy/scanner/scan-project.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { CanopyDeltaScanRunner } from './canopy-delta-scan.js';
import { CanopyBackgroundScan } from './canopy-background-scan.js';

export interface CanopyJobContext {
  db: Database;
  logger: DaemonLogger;
  machineId: string;
  projectRoot: string;
  /** Stable identifier for the canopy project_id column. */
  projectId: string;
  liveConfig: { current: MycoConfig };
}

/**
 * One-shot full project scan. Used for initial populate on first daemon boot
 * after the feature lands and as a manual rescue if the index drifts. Logs
 * the result; the caller decides whether to retry.
 */
export interface CanopyJobsRegistration {
  /** The shared delta runner — also exposed so the SessionStart hook bridge can trigger it. */
  delta: CanopyDeltaScanRunner;
  /** Manual full-scan trigger (used for the initial populate after first install). */
  runFullScan: () => Promise<void>;
}

/**
 * Register the three canopy jobs with PowerManager and return handles for
 * the SessionStart bridge and the initial-populate path.
 */
export function registerCanopyJobs(
  powerManager: PowerManager,
  ctx: CanopyJobContext,
): CanopyJobsRegistration {
  const delta = new CanopyDeltaScanRunner(ctx);
  const background = new CanopyBackgroundScan({
    liveConfig: ctx.liveConfig,
    delta,
    logger: ctx.logger,
  });

  // Background driver: runs whenever PowerManager ticks in any non-deep state.
  // The driver itself enforces the configured period; PowerManager just
  // gives it a heartbeat.
  powerManager.register({
    name: 'canopy-background-scan',
    runIn: ['active', 'idle', 'sleep'],
    fn: () => background.tick(),
  });

  return {
    delta,
    runFullScan: () => runCanopyScan(ctx),
  };
}

export async function runCanopyScan(ctx: CanopyJobContext): Promise<void> {
  const patterns = ctx.liveConfig.current.canopy.exclude.patterns;
  try {
    const result = scanProject({
      db: ctx.db,
      projectId: ctx.projectId,
      machineId: ctx.machineId,
      projectRoot: ctx.projectRoot,
      excludePatterns: patterns,
    });
    ctx.logger.info(LOG_KINDS.CANOPY_SCAN, 'Canopy full scan complete', {
      ...result,
    });
  } catch (err) {
    ctx.logger.error(LOG_KINDS.CANOPY_ERROR, 'Canopy full scan failed', {
      error: (err as Error).message,
    });
  }
}
