/**
 * Background auto-check + stage, and idle/sleep auto-adopt.
 *
 * checkAndStage   — resolves the channel target via release-resolver;
 *                   if the target is strictly newer than `currentVersion` AND
 *                   not already staged, stages the binary via `stageBinary`.
 *                   No-ops on manual-channel machines, when already staged,
 *                   or when the resolved version is not strictly newer.
 *
 * buildAdoptJobFn — returns the `RunnerJob` fn body for `upgrade-adopt`.
 *                   Registered as `runIn: ['idle', 'sleep']` so it only fires
 *                   when the user is away. The `inFlight` guard (from
 *                   `upgrade/in-progress.ts`) is what makes it fire
 *                   once-per-staged-version, not once-per-tick. Never throws
 *                   past its boundary — failures are logged and the job returns
 *                   so the tick and other jobs are never starved.
 *
 * Design note — level-triggered, not transition-triggered:
 *   `power.ts` has NO transition event; `JobRunner.dispatch` is called on every
 *   tick in the matching state. `inFlight()` is the idempotency gate: once the
 *   adopt orchestrator has been spawned and the sentinel written, every subsequent
 *   tick sees the in-flight sentinel and no-ops until the daemon restarts onto the
 *   new binary (which clears the sentinel on startup if the target matches).
 */

import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';

import {
  resolveMycoBinaryUpdateRefs,
} from './release-resolver.js';
import { stageBinary, DEFAULT_BINARY_UPDATE_DEPS, type StageBinaryDeps } from './apply-binary.js';
import { initiateAdopt } from './adopt.js';
import type { InitiateAdoptOpts } from './adopt.js';
import { inFlight as inProgressInFlight, write as writeInProgress, sentinelPath as inProgressSentinelPathFn } from './in-progress.js';
import {
  versionsDir,
  versionDir,
  versionBinaryPath,
} from '../install/managed-binary.js';
import { releaseChannelIsManual } from '../daemon/update-checker.js';
import { isDefaultMycoHome } from '../grove/paths.js';
import type { Logger } from '../daemon/logger.js';
import type { JobRunContext, JobOutcome } from '../daemon/job-runner.js';
import type { ReleaseChannel } from '../constants/update.js';
import type { AssetRefs } from './release-assets.js';

// ---------------------------------------------------------------------------
// checkAndStage deps (injectable for tests)
// ---------------------------------------------------------------------------

export interface CheckAndStageDeps {
  /** Resolves the binary update refs for the given channel. Override in tests. */
  resolveRefs?: (channel: ReleaseChannel) => Promise<AssetRefs | null>;
  /** Stage the binary. Defaults to the real `stageBinary`. */
  stageBinary?: typeof stageBinary;
  /** Download + hash deps for `stageBinary`. Defaults to DEFAULT_BINARY_UPDATE_DEPS. */
  stageDeps?: StageBinaryDeps;
  /** Check if a path exists (defaults to fs.existsSync). */
  existsSync?: (p: string) => boolean;
  /**
   * Override the manual-channel gate. Defaults to `releaseChannelIsManual()`.
   * Tests pass `() => true` to simulate a manual-channel machine.
   */
  isManualChannel?: () => boolean;
}

// ---------------------------------------------------------------------------
// checkAndStage result
// ---------------------------------------------------------------------------

export type CheckAndStageResult =
  | { status: 'staged'; version: string }
  | { status: 'noop'; reason: 'manual-channel' | 'up-to-date' | 'already-staged' }
  | { status: 'error'; error: string };

// ---------------------------------------------------------------------------
// adoptJobFn opts (injected by the registration site in power-jobs.ts)
// ---------------------------------------------------------------------------

export interface AutoAdoptDeps {
  /** The version currently running (e.g. `server.version`). */
  currentVersion: string;
  /** Myco home directory. */
  home: string;
  /** Target platform. */
  platform: NodeJS.Platform;
  /** %LOCALAPPDATA% on win32; ignored on non-win32. */
  localAppData?: string;
  /** The daemon state dir (for `update.in-progress` sentinel path). */
  stateDir: string;
  /** Daemon port (for health probe after adopt). */
  daemonPort: number;
  /**
   * Resolve the service-managed label at adopt time. Called once per
   * invocation that actually proceeds to initiate (i.e. after the
   * inFlight+staged guards pass). Return null when not service-managed.
   * Override in tests to return a fixed value without spawning processes.
   */
  resolveServiceLabel?: () => Promise<string | null>;
  /** The myco binary path used for direct-spawn restart fallback. Defaults to 'myco'. */
  mycoBinary?: string;
  /** Project root for direct-spawn restart cwd. */
  projectRoot: string;
  /** Daemon logger. */
  logger: Logger;
  /** Override initiateAdopt for testing. */
  initiateAdopt?: typeof initiateAdopt;
  /**
   * Override the manual-channel gate. Defaults to `releaseChannelIsManual()`.
   * Tests pass `() => true` to simulate a manual-channel machine.
   */
  isManualChannel?: () => boolean;
  /**
   * Override the default-home gate. Defaults to `isDefaultMycoHome`. Only the
   * default home (~/.myco) self-updates via adopt; a non-default home runs a
   * separately-pinned binary. Tests pass `() => true` to exercise the adopt path
   * from a tmpdir home.
   */
  isDefaultHome?: (home: string) => boolean;
}

// ---------------------------------------------------------------------------
// checkAndStage
// ---------------------------------------------------------------------------

/**
 * Check GitHub for a newer release on the configured channel and, if found
 * and not already staged, download+verify+stage it into `versions/<v>/`.
 *
 * NO-OPS when:
 *   - `releaseChannelIsManual()` — manual-channel machine; operator must initiate.
 *   - The resolved version is not strictly > currentVersion.
 *   - The versioned binary already exists on disk (already staged or adopted).
 *
 * On success the staged binary lands under `<bindir>/versions/<targetVersion>/myco`.
 * Task 5's `initiateAdopt` (called by `buildAdoptJobFn`) is responsible for
 * copying it onto the managed binary path + restarting.
 */
export async function checkAndStage(
  currentVersion: string,
  opts: {
    home: string;
    platform: NodeJS.Platform;
    localAppData?: string;
    logger: Logger;
    channel: ReleaseChannel;
  },
  deps: CheckAndStageDeps = {},
): Promise<CheckAndStageResult> {
  // Manual-channel machines must never auto-stage or adopt.
  const manualChannelCheck = deps.isManualChannel ?? releaseChannelIsManual;
  if (manualChannelCheck()) {
    return { status: 'noop', reason: 'manual-channel' };
  }

  const { home, platform, localAppData, logger, channel } = opts;

  // Resolve deps with defaults.
  const resolveRefsFn = deps.resolveRefs ?? ((ch: ReleaseChannel) => resolveMycoBinaryUpdateRefs(ch));
  const stageBinaryFn = deps.stageBinary ?? stageBinary;
  const stageDeps = deps.stageDeps ?? DEFAULT_BINARY_UPDATE_DEPS;
  const existsSyncFn = deps.existsSync ?? ((p: string) => fs.existsSync(p));

  let refs: AssetRefs | null;
  try {
    refs = await resolveRefsFn(channel);
  } catch (err) {
    return { status: 'error', error: `release resolution failed: ${String(err)}` };
  }

  if (refs === null) {
    // No release matched (e.g. stable channel with no stable release yet).
    return { status: 'noop', reason: 'up-to-date' };
  }

  const { targetVersion } = refs;

  // No-downgrade rule: only stage when target is STRICTLY newer.
  if (
    !semver.valid(targetVersion) ||
    !semver.valid(currentVersion) ||
    !semver.gt(targetVersion, currentVersion)
  ) {
    return { status: 'noop', reason: 'up-to-date' };
  }

  // Already-staged guard: if the versioned binary exists on disk, nothing to do.
  const vBinPath = versionBinaryPath(home, platform, targetVersion, localAppData);
  if (existsSyncFn(vBinPath)) {
    return { status: 'noop', reason: 'already-staged' };
  }

  logger.info('upgrade', 'Auto-check staging new version', {
    current_version: currentVersion,
    target_version: targetVersion,
    channel,
  });

  const result = await stageBinaryFn(
    { refs, home, platform, localAppData },
    stageDeps,
  );

  if ('error' in result) {
    logger.error('upgrade', 'Auto-check stage failed', { error: result.error, target_version: targetVersion });
    return { status: 'error', error: result.error };
  }

  logger.info('upgrade', 'Auto-check staged successfully', {
    version: result.version,
    versionDir: result.versionDir,
  });
  return { status: 'staged', version: result.version };
}

// ---------------------------------------------------------------------------
// Failed-adopt marker
// ---------------------------------------------------------------------------

/**
 * Marker file written into a versioned slot when an adopt of that version
 * FAILED (the daemon came back on a different version). `resolveNewestStagedVersion`
 * skips marked versions so a known-bad release is not re-adopted on every idle
 * tick — without it the loop is only bounded by the ~10-min sentinel stale sweep.
 */
const ADOPT_FAILED_MARKER = '.adopt-failed';

/**
 * Record that adopting `version` failed by writing the marker into its versioned
 * slot. Best-effort and never throws — a missing marker only costs one extra
 * (bounded) retry. Called from the daemon startup path when the running version
 * does not match the sentinel's target (see daemon/main.ts).
 */
export function markAdoptFailed(
  home: string,
  platform: NodeJS.Platform,
  version: string,
  localAppData?: string,
): void {
  try {
    const dir = versionDir(home, platform, version, localAppData);
    if (!fs.existsSync(dir)) return;
    fs.writeFileSync(path.join(dir, ADOPT_FAILED_MARKER), `${new Date().toISOString()}\n`);
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Helper: resolve the newest staged version strictly greater than current
// ---------------------------------------------------------------------------

/**
 * Scan `<bindir>/versions/` and return the highest staged version strictly
 * greater than `currentVersion`, or null when none found.
 *
 * Uses `semver.compare` for sorting (newest-first).
 */
export function resolveNewestStagedVersion(
  home: string,
  platform: NodeJS.Platform,
  currentVersion: string,
  localAppData?: string,
  existsSyncFn: (p: string) => boolean = (p) => fs.existsSync(p),
  readdirSyncFn: (p: string) => string[] = (p) => fs.readdirSync(p) as string[],
): string | null {
  const vDir = versionsDir(home, platform, localAppData);
  if (!existsSyncFn(vDir)) return null;

  let entries: string[];
  try {
    entries = readdirSyncFn(vDir);
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => semver.valid(entry) !== null)
    .filter((entry) => semver.gt(entry, currentVersion))
    // Skip versions whose adopt already failed (marker in the slot) — otherwise a
    // known-bad release is re-adopted on every idle tick / stale-window.
    .filter(
      (entry) => !existsSyncFn(path.join(versionDir(home, platform, entry, localAppData), ADOPT_FAILED_MARKER)),
    )
    // Sort newest-first.
    .sort((a, b) => semver.compare(semver.valid(b)!, semver.valid(a)!));

  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// adoptJobFn — the RunnerJob body
// ---------------------------------------------------------------------------

/**
 * Build the `upgrade-adopt` job function.
 *
 * The returned function is the `fn` field of the `RunnerJob`:
 *   {
 *     name: 'upgrade-adopt',
 *     runIn: ['idle', 'sleep'],
 *     kind: 'housekeeping',
 *     fn: buildAdoptJobFn(deps),
 *   }
 *
 * Safety guarantees:
 *   - The fn body is wrapped so it can NEVER throw past its boundary: any
 *     failure logs and returns; the tick and all other jobs continue normally.
 *   - The `inFlight` guard makes it fire once-per-staged-version, not per-tick:
 *     once `initiateAdopt` writes the sentinel, every subsequent tick sees it
 *     and no-ops until the daemon restarts onto the new version (which clears
 *     the sentinel on target-version match at startup).
 *   - No downgrade: only adopts when staged > current.
 *   - `active` is NOT in `runIn` — adopt must not interrupt a live session.
 */
export function buildAdoptJobFn(
  adoptDeps: AutoAdoptDeps,
): (ctx: JobRunContext) => Promise<JobOutcome | void> {
  return async (_ctx: JobRunContext): Promise<void> => {
    try {
      // Manual-channel no-op (belt-and-suspenders — checkAndStage also guards).
      const manualChannelCheck = adoptDeps.isManualChannel ?? releaseChannelIsManual;
      if (manualChannelCheck()) return;

      const {
        currentVersion,
        home,
        platform,
        localAppData,
        stateDir,
        daemonPort,
        mycoBinary,
        projectRoot,
        logger,
      } = adoptDeps;

      // Binary self-update converges the canonical install (~/.myco). A
      // non-default home runs a separately-pinned binary; adopting a release
      // there can never converge (the supervisor re-launches the pinned binary),
      // so never attempt it.
      const isDefaultHomeCheck = adoptDeps.isDefaultHome ?? isDefaultMycoHome;
      if (!isDefaultHomeCheck(home)) return;

      // inFlight guard: an adopt is already in progress → no-op.
      if (inProgressInFlight(stateDir) !== null) return;

      // Find the highest staged version strictly > current.
      const stagedVersion = resolveNewestStagedVersion(home, platform, currentVersion, localAppData);
      if (stagedVersion === null) return;

      // Confirm the staged binary actually exists on disk.
      const stagedBinPath = versionBinaryPath(home, platform, stagedVersion, localAppData);
      if (!fs.existsSync(stagedBinPath)) return;

      logger.info('upgrade', 'Auto-adopt: initiating adopt of staged version', {
        current_version: currentVersion,
        staged_version: stagedVersion,
      });

      // Resolve the service-managed label at adopt time so the orchestrator
      // knows whether to let the supervisor restart or do a direct spawn.
      const resolveServiceLabel = adoptDeps.resolveServiceLabel ?? (async () => {
        const { getServiceManager } = await import('../service/manager.js');
        const { resolveRestartServiceLabel } = await import('../daemon/api/restart.js');
        return resolveRestartServiceLabel(getServiceManager());
      });
      const serviceManagedLabel = await resolveServiceLabel();

      const initiateAdoptFn = adoptDeps.initiateAdopt ?? initiateAdopt;

      // Write the update.in-progress sentinel BEFORE calling initiateAdopt so
      // that subsequent idle ticks see it and no-op even if the cooperative
      // shutdown fails silently (matching the self-reconcile-wiring.ts pattern).
      // The sentinel write is inside the try/catch so a write failure cannot
      // wedge the tick — it is caught, logged, and the job returns cleanly.
      const sentinelPath = inProgressSentinelPathFn(stateDir);
      writeInProgress(stateDir, {
        targetVersion: stagedVersion,
        startedAt: Date.now(),
        initiator: 'daemon',
      });

      const adoptOpts: InitiateAdoptOpts = {
        source: 'daemon',
        targetVersion: stagedVersion,
        prevVersion: currentVersion,
        home,
        platform,
        localAppData,
        daemonPort,
        serviceManagedLabel,
        mycoBinary: mycoBinary ?? 'myco',
        projectRoot,
        // Thread the sentinel path so the detached orchestrator clears it on
        // abort / stop-not-confirmed / crash-loop-restore (matching
        // self-reconcile-wiring.ts ~line 179).
        inProgressSentinelPath: sentinelPath,
      };

      await initiateAdoptFn(adoptOpts);
    } catch (err) {
      // buildAdoptJobFn MUST never propagate: a failure must not wedge the tick.
      try {
        adoptDeps.logger.error('upgrade', 'Auto-adopt job failed (contained)', {
          error: String(err),
        });
      } catch {
        /* logging is best-effort */
      }
    }
  };
}
