import type { Database } from 'bun:sqlite';
import type { DaemonLogger } from '../logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { PowerManager } from '../power.js';
import { scanProject } from '@myco/canopy/scanner/scan-project.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { CanopyDeltaScanRunner } from './canopy-delta-scan.js';
import { CanopyBackgroundScan } from './canopy-background-scan.js';

/**
 * Threshold above which a delta-scan's `added` count counts as a "mass
 * re-add" and triggers an imperative kick of canopy-describe. Tuned to
 * be high enough that a normal session of edits doesn't trigger but low
 * enough that a recovery from a project_root divergence (or a fresh
 * clone) does. The natural baseline of mechanical churn from one
 * working session adds ~1–5 rows; ten is comfortably above that.
 */
const DELTA_SCAN_MASS_ADD_KICK_THRESHOLD = 10;

export interface CanopyJobContext {
  db: Database;
  logger: DaemonLogger;
  machineId: string;
  projectRoot: string;
  /** Stable identifier for the canopy project_id column. */
  projectId: string;
  liveConfig: { current: MycoConfig };
  /**
   * Optional callback invoked after a scan that added more than
   * DELTA_SCAN_MASS_ADD_KICK_THRESHOLD new rows. Used to imperatively
   * kick canopy-describe so newly-NULL descriptions start draining
   * immediately instead of waiting for the next scheduled tick.
   * Implementations must be cheap and synchronous-safe.
   */
  onCanopyMassAdd?: () => void;
}

export { DELTA_SCAN_MASS_ADD_KICK_THRESHOLD };

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
  /** Initial populate trigger; no-ops when the project already has canopy rows. */
  runInitialPopulate: () => Promise<void>;
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
    runInitialPopulate: () => runInitialCanopyPopulate(ctx),
  };
}

function deferCanopyWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function runInitialCanopyPopulate(ctx: CanopyJobContext): Promise<void> {
  const row = ctx.db
    .prepare('SELECT 1 AS present FROM canopy_entries WHERE project_id = ? LIMIT 1')
    .get(ctx.projectId) as { present: number } | undefined;
  if (row) return;
  await deferCanopyWork();
  await runCanopyScan(ctx);
}

export async function runCanopyScan(ctx: CanopyJobContext): Promise<void> {
  const exclude = ctx.liveConfig.current.cortex.canopy.exclude;
  try {
    const result = scanProject({
      db: ctx.db,
      projectId: ctx.projectId,
      machineId: ctx.machineId,
      projectRoot: ctx.projectRoot,
      defaultExcludePatterns: exclude.default_patterns,
      excludePatterns: exclude.patterns,
    });
    ctx.logger.info(LOG_KINDS.CANOPY_SCAN, 'Canopy full scan complete', {
      ...result,
    });
    if (result.added > DELTA_SCAN_MASS_ADD_KICK_THRESHOLD) {
      ctx.onCanopyMassAdd?.();
    }
  } catch (err) {
    ctx.logger.error(LOG_KINDS.CANOPY_ERROR, 'Canopy full scan failed', {
      error: (err as Error).message,
    });
  }
}
