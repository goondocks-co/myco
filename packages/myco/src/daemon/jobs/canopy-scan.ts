/**
 * Canopy scan jobs — per-project across every registered Grove.
 *
 * The daemon owns one process for many Groves and many projects-per-Grove.
 * Each project keeps its own canopy index in its Grove's DB, so:
 *
 * - Delta scans must be dispatchable per project (SessionStart triggers
 *   the project that fired the hook; the background tick fans out to
 *   every registered project).
 * - Initial populate runs once per project on boot, no-ops when the
 *   project already has rows.
 * - Mass-add detection per scan kicks the canopy-describe scheduler so
 *   freshly inserted NULL descriptions start draining immediately.
 *
 * State design:
 *
 * - `CanopyDeltaScanRunner` owns a project's debounce + in-flight state.
 *   It is created lazily on first dispatch and lives for the daemon's
 *   lifetime in `CanopyJobsRegistry.runners`.
 * - The runner re-resolves the per-project DB through `resolveDb` on every
 *   execute so a Grove evicted from `GroveRuntimeCache` and reopened later
 *   never leaves a stale handle behind.
 */

import type { Database } from 'bun:sqlite';
import type { DaemonLogger } from '../logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { PowerManager } from '../power.js';
import { scanProject } from '@myco/canopy/scanner/scan-project.js';
import { deltaScan } from '@myco/canopy/scanner/delta-scan.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { POWER_JOB_NAMES } from '@myco/constants/power-jobs.js';
import type { GroveProjectId } from '@myco/grove/ids.js';

/**
 * Threshold above which a scan's `added` count counts as a "mass re-add"
 * and triggers an imperative kick of canopy-describe. High enough that a
 * normal session of edits doesn't trigger but low enough that recovery
 * from a project_root divergence (or a fresh clone) does. The natural
 * baseline of mechanical churn from one working session adds ~1–5 rows;
 * ten is comfortably above that.
 */
export const DELTA_SCAN_MASS_ADD_KICK_THRESHOLD = 10;

/** Coalesce delta-scan triggers fired within this window into one run. */
export const CANOPY_DELTA_DEBOUNCE_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Identity of the project owning this canopy index. Carried per runner so
 * scan calls hit the right `(database, project)` tuple even when the
 * runner is dispatched from a fan-out context that isn't the boot project.
 */
export interface CanopyRunnerIdentity {
  databasePath: string;
  projectId: GroveProjectId;
  projectRoot: string;
  /** Owning Grove id — required so kickers can target Grove-keyed schedule state. */
  groveId: string;
}

/**
 * Daemon-wide deps shared across every per-project runner.
 *
 * `resolveDb(databasePath)` re-routes through the runtime cache so a
 * Grove DB that was evicted between ticks is reopened cleanly instead
 * of leaving the runner pinned to a closed handle.
 */
export interface CanopyRunnerSharedDeps {
  logger: DaemonLogger;
  machineId: string;
  liveConfig: { current: MycoConfig };
  resolveDb: (databasePath: string) => Database;
  /**
   * Fired after a scan that adds more than
   * DELTA_SCAN_MASS_ADD_KICK_THRESHOLD new rows. The runner passes its
   * own project id so the kicker can route to the right project's
   * canopy-describe slot in the per-project scheduler. Implementations
   * must be cheap and synchronous-safe.
   */
  onCanopyMassAdd?: (groveId: string, projectId: GroveProjectId) => void;
}

// ---------------------------------------------------------------------------
// Per-project delta runner
// ---------------------------------------------------------------------------

/**
 * Process-local debouncer for a project's delta scan. Multiple
 * session-start hooks landing within `CANOPY_DELTA_DEBOUNCE_MS` collapse
 * to a single walk; the unused triggers are dropped silently because the
 * work they would do has already been done.
 */
export class CanopyDeltaScanRunner {
  // Sentinel so the first call always proceeds regardless of injected clock.
  private lastRunAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly identity: CanopyRunnerIdentity,
    private readonly shared: CanopyRunnerSharedDeps,
  ) {}

  /**
   * Run a delta scan unless one ran within the debounce window or one is
   * already in flight. Both gates are necessary: the time gate handles the
   * "two session-start hooks back-to-back" case; the in-flight gate handles
   * the "background tick fires while session-start is still running" case.
   *
   * The supplied `now` is also used to stamp `lastRunAt` so a single
   * monotonic clock source drives both reads and writes — important for
   * tests that inject a deterministic clock.
   */
  async run(now: number = Date.now()): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (now - this.lastRunAt < CANOPY_DELTA_DEBOUNCE_MS) return;
    this.inFlight = this.execute().finally(() => {
      this.lastRunAt = now;
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async execute(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const exclude = this.shared.liveConfig.current.cortex.canopy.exclude;
    const db = this.shared.resolveDb(this.identity.databasePath);
    try {
      const result = deltaScan({
        db,
        projectId: this.identity.projectId,
        machineId: this.shared.machineId,
        projectRoot: this.identity.projectRoot,
        defaultExcludePatterns: exclude.default_patterns,
        excludePatterns: exclude.patterns,
      });
      this.shared.logger.info(LOG_KINDS.CANOPY_SCAN, 'Canopy delta scan complete', {
        ...result,
        project_id: this.identity.projectId,
      });
      // Mass-add detection: a delta scan that re-adds many rows means
      // either initial populate just landed or something earlier wiped
      // rows that have now been restored. New rows have NULL
      // llm_description; kick canopy-describe so the queue starts
      // draining immediately instead of waiting up to one full
      // scheduled interval.
      if (result.added > DELTA_SCAN_MASS_ADD_KICK_THRESHOLD) {
        this.shared.onCanopyMassAdd?.(this.identity.groveId, this.identity.projectId);
      }
    } catch (err) {
      this.shared.logger.error(LOG_KINDS.CANOPY_ERROR, 'Canopy delta scan failed', {
        error: (err as Error).message,
        project_id: this.identity.projectId,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Per-project background-scan dispatcher state
// ---------------------------------------------------------------------------

/**
 * Single daemon-wide background dispatcher. The PowerManager ticks it on
 * every active/idle/sleep tick; the dispatcher enforces the configured
 * `background_period_minutes` gate, then fans out to every registered
 * project's runner via the `dispatchAll` callback.
 *
 * Per-project debouncing inside each runner means a flap or burst of
 * SessionStart hooks during the same window collapses cleanly — the
 * background tick is just one more trigger.
 */
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

export class CanopyBackgroundScanDispatcher {
  private lastDispatchedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly liveConfig: { current: MycoConfig },
    private readonly logger: DaemonLogger,
    private readonly dispatchAll: (now: number) => Promise<void>,
  ) {}

  async tick(): Promise<void> {
    const cfg = this.liveConfig.current.cortex.canopy.refresh;
    if (!cfg.background_enabled) return;
    const periodSeconds = cfg.background_period_minutes * SECONDS_PER_MINUTE;
    if (periodSeconds <= 0) return;
    const now = Date.now();
    if (now - this.lastDispatchedAt < periodSeconds * MS_PER_SECOND) return;
    this.lastDispatchedAt = now;
    try {
      await this.dispatchAll(now);
    } catch (err) {
      this.logger.error(LOG_KINDS.CANOPY_ERROR, 'Canopy background scan dispatch failed', {
        error: (err as Error).message,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Project-keyed registry
// ---------------------------------------------------------------------------

/**
 * Holds one `CanopyDeltaScanRunner` per project, materialized on first
 * dispatch. Lookups by `projectId` are used by:
 *
 * - The session-register path, which triggers a project's delta scan on
 *   each SessionStart so the index stays current with on-disk changes
 *   that happened between sessions.
 * - The background scan dispatcher, which iterates every registered
 *   project on each tick.
 * - `runInitialPopulate`, which seeds canopy on first daemon boot for
 *   every project at once.
 */
export class CanopyJobsRegistry {
  private readonly runners = new Map<string, CanopyDeltaScanRunner>();

  constructor(private readonly shared: CanopyRunnerSharedDeps) {}

  /** Get-or-create a per-project runner. Cheap; safe to call repeatedly. */
  ensureRunner(identity: CanopyRunnerIdentity): CanopyDeltaScanRunner {
    const existing = this.runners.get(identity.projectId);
    if (existing) return existing;
    const runner = new CanopyDeltaScanRunner(identity, this.shared);
    this.runners.set(identity.projectId, runner);
    return runner;
  }

  /** Look up an existing runner without materializing one. */
  getRunner(projectId: GroveProjectId): CanopyDeltaScanRunner | undefined {
    return this.runners.get(projectId);
  }

  /**
   * Initial populate for one project: a full `scanProject` if the
   * project has no canopy rows yet, otherwise a no-op. Used on boot to
   * seed every registered project, so a fresh install indexes the
   * machine's whole project surface area without waiting for the first
   * background tick.
   */
  async initialPopulate(identity: CanopyRunnerIdentity): Promise<void> {
    const db = this.shared.resolveDb(identity.databasePath);
    const row = db
      .prepare('SELECT 1 AS present FROM canopy_entries WHERE project_id = ? LIMIT 1')
      .get(identity.projectId) as { present: number } | undefined;
    if (row) return;
    // Defer one tick so the boot path doesn't block on a long full scan.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await this.runFullScan(identity);
  }

  /**
   * One-shot full project scan. Used for initial populate and as a
   * manual rescue path. Logs the result; the caller decides whether to
   * retry. Mass-add detection re-uses the threshold so a fresh full
   * scan kicks the describe scheduler the same way a delta does.
   */
  async runFullScan(identity: CanopyRunnerIdentity): Promise<void> {
    const exclude = this.shared.liveConfig.current.cortex.canopy.exclude;
    const db = this.shared.resolveDb(identity.databasePath);
    try {
      const result = scanProject({
        db,
        projectId: identity.projectId,
        machineId: this.shared.machineId,
        projectRoot: identity.projectRoot,
        defaultExcludePatterns: exclude.default_patterns,
        excludePatterns: exclude.patterns,
      });
      this.shared.logger.info(LOG_KINDS.CANOPY_SCAN, 'Canopy full scan complete', {
        ...result,
        project_id: identity.projectId,
      });
      if (result.added > DELTA_SCAN_MASS_ADD_KICK_THRESHOLD) {
        this.shared.onCanopyMassAdd?.(identity.groveId, identity.projectId);
      }
    } catch (err) {
      this.shared.logger.error(LOG_KINDS.CANOPY_ERROR, 'Canopy full scan failed', {
        error: (err as Error).message,
        project_id: identity.projectId,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// PowerManager registration
// ---------------------------------------------------------------------------

export interface CanopyJobsContext {
  logger: DaemonLogger;
  machineId: string;
  liveConfig: { current: MycoConfig };
  resolveDb: (databasePath: string) => Database;
  /**
   * Background dispatcher fan-out callback. Invoked once per tick when the
   * `background_period_minutes` gate has elapsed. Implementations should
   * iterate every registered project and call `registry.ensureRunner(...).run(now)`.
   */
  dispatchBackground: (registry: CanopyJobsRegistry, now: number) => Promise<void>;
  onCanopyMassAdd?: (groveId: string, projectId: GroveProjectId) => void;
}

export interface CanopyJobsRegistration {
  /** Per-project runner registry. Used by the session-register bridge and initial-populate path. */
  registry: CanopyJobsRegistry;
}

/**
 * Register the canopy background-scan PowerManager job and return the
 * project-keyed registry the daemon uses to dispatch on SessionStart.
 */
export function registerCanopyJobs(
  powerManager: PowerManager,
  ctx: CanopyJobsContext,
): CanopyJobsRegistration {
  const registry = new CanopyJobsRegistry({
    logger: ctx.logger,
    machineId: ctx.machineId,
    liveConfig: ctx.liveConfig,
    resolveDb: ctx.resolveDb,
    onCanopyMassAdd: ctx.onCanopyMassAdd,
  });

  const dispatcher = new CanopyBackgroundScanDispatcher(
    ctx.liveConfig,
    ctx.logger,
    (now) => ctx.dispatchBackground(registry, now),
  );

  powerManager.register({
    name: POWER_JOB_NAMES.CANOPY_BACKGROUND_SCAN,
    runIn: ['active', 'idle', 'sleep'],
    fn: () => dispatcher.tick(),
  });

  return { registry };
}
