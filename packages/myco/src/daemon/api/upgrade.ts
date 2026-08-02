/**
 * Upgrade API handlers — status, manual check, apply, and channel switch.
 *
 * Factory function injects vaultDir, projectRoot, currentVersion, home,
 * platform, localAppData, and a scheduleShutdown callback; returns handlers for:
 *   GET  /api/upgrade/status
 *   POST /api/upgrade/check
 *   POST /api/upgrade/apply
 *   PUT  /api/upgrade/channel
 *
 * status assembles packages[] from cache; check uses resolveMycoPackageCheck
 * (live fetch), then persists to cache. The apply path drives initiateAdopt
 * (staged binary) directly. Version-sync self-restart (spawnRestartScript +
 * restarting/reason) is retained.
 */

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';

import {
  releaseChannelIsManual,
  readCachedCheck,
  readUpdateConfig,
  readProjectReleaseChannel,
  writeProjectReleaseChannel,
  clearCachedCheck,
  isCacheStale,
  getInstalledVersion,
  resolveMycoBinary,
  resolveRuntimeCommand,
} from '../update-checker.js';
import type { CachedCheck, UpdateConfig } from '../update-checker.js';
import { TierConfigUnreadableError } from '../../config/loader.js';
import { spawnRestartScript } from '@myco/upgrade/spawn.js';
import { initiateAdopt } from '@myco/upgrade/adopt.js';
import {
  readMaxStampedSchemaVersion,
  readSupportedSchemaVersion,
  rollbackWouldCrossSchemaGap,
  SchemaGapDowngradeError,
} from '@myco/upgrade/schema-gap.js';
import { resolveMycoPackageCheck } from '@myco/upgrade/checker.js';
import type { PackageCheckResult } from '@myco/upgrade/checker.js';
import { resolveMycoBinaryUpdateRefs } from '@myco/upgrade/release-resolver.js';
import { stageBinary, DEFAULT_BINARY_UPDATE_DEPS } from '@myco/upgrade/apply-binary.js';
import type { StageBinaryDeps } from '@myco/upgrade/apply-binary.js';
import type { AssetRefs } from '@myco/upgrade/release-assets.js';
import * as updateInProgress from '@myco/upgrade/in-progress.js';
import { resolveNewestStagedVersion } from '@myco/upgrade/auto-check.js';
import { versionBinaryPath } from '../../install/managed-binary.js';
import {
  RELEASE_CHANNELS,
  NPM_PACKAGE_NAME,
  UPDATE_PACKAGES,
  UPDATE_CHECK_CACHE_PATH,
} from '../../constants/update.js';
import type { ReleaseChannel, UpdatePackageId } from '../../constants/update.js';
import { resolveLastUpdateVersionPath, isDefaultMycoHome } from '../../grove/paths.js';
import { resolveRestartServiceLabel } from './restart.js';
import { getServiceManager } from '../../service/manager.js';
import type { ServiceManager } from '../../service/types.js';
import type { RouteRequest, RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Re-exported types
// ---------------------------------------------------------------------------

export type { PackageCheckResult };

/** Result returned by the upgrade status/check endpoints. */
export interface CheckResult {
  update_available: boolean;
  /** True when any package has `revert_available` set. */
  revert_available: boolean;
  running_version: string;
  latest_version: string;
  /**
   * `latest_stable ?? currentVersion` — mirrors upgrade/checker.ts convention
   * so the revert/update logic always has a clean comparison base.
   */
  latest_stable: string;
  latest_beta: string | null;
  channel: ReleaseChannel;
  /** Always `'machine'` — the channel is machine-scoped (decision-46130740). */
  channel_scope: 'machine';
  /**
   * Always `'machine'` — myco is a single managed binary at `~/.myco/bin/myco`
   * swapped in place. The legacy `'managed'` value was retired with the native
   * installer; the field is kept in the API contract for stability.
   */
  runtime_scope: 'machine';
  check_interval_hours: number;
  last_check: string;
  error: string | null;
  packages: PackageCheckResult[];
}

/** Dependencies injected by the daemon when registering upgrade routes. */
export interface UpgradeDeps {
  /** Absolute path to the active vault directory. */
  vaultDir: string;
  /** Absolute path to the project root. */
  projectRoot: string;
  /** The currently running version (from package.json at startup). */
  currentVersion: string;
  /**
   * Canonical port the running daemon is listening on. Baked into the
   * detached restart scripts so their readiness probe can find /health.
   */
  daemonPort: number;
  /** Callback that schedules a graceful daemon shutdown. */
  scheduleShutdown: () => void;
  /** npm global prefix, resolved once at daemon startup. Null if resolution failed. */
  globalPrefix: string | null;
  /** Daemon state directory. The update-in-progress sentinel lives here. */
  daemonStateDir: string;
  /** Myco home directory (`~/.myco`). Used for staged-version discovery. */
  home: string;
  /** Platform — controls binary path computation for staged versions. */
  platform: NodeJS.Platform;
  /** %LOCALAPPDATA% on win32; ignored on non-win32. */
  localAppData?: string;
  /** Optional override for tests; defaults to the platform service manager. */
  serviceManager?: ServiceManager;
  /**
   * Resolve the binary-update refs for the given channel + this machine. Used
   * by the revert-to-stable path to resolve the stable target DIRECTLY (it may
   * be a LOWER version than the running prerelease, so the strictly-greater
   * staged-version scan cannot find it). Defaults to the real channel resolver;
   * tests override it to avoid network calls.
   */
  resolveRevertRefs?: (channel: ReleaseChannel) => Promise<AssetRefs | null>;
  /** Stage a resolved binary. Defaults to the real `stageBinary`. Test override. */
  stageBinary?: typeof stageBinary;
  /** Download/hash deps for `stageBinary`. Defaults to DEFAULT_BINARY_UPDATE_DEPS. */
  stageDeps?: StageBinaryDeps;
  /** Inject the vault-side schema scan (downgrade schema-gap guard). Test override. */
  readMaxStampedSchemaVersion?: typeof readMaxStampedSchemaVersion;
  /** Inject the target-binary supported-schema read (downgrade schema-gap guard). */
  readSupportedSchemaVersion?: typeof readSupportedSchemaVersion;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const ChannelBodySchema = z.object({
  channel: z.enum(RELEASE_CHANNELS),
});

// ---------------------------------------------------------------------------
// Cache-derived CheckResult assembly helpers
// ---------------------------------------------------------------------------

function buildInstalledVersions(
  currentVersion: string,
): Record<UpdatePackageId, string | null> {
  // `myco` is the only UPDATE_PACKAGES entry; its installed version is
  // always the running binary's version.
  return { myco: currentVersion };
}

function resolveTargetFromCache(
  latestStable: string,
  latestBeta: string | null,
  channel: ReleaseChannel,
): string {
  if (channel === 'stable' || latestBeta === null) return latestStable;
  return semver.gt(latestBeta, latestStable) ? latestBeta : latestStable;
}

function buildPackagesFromCache(
  currentVersion: string,
  cache: CachedCheck,
  channel: ReleaseChannel,
): PackageCheckResult[] {
  const installedVersions = buildInstalledVersions(currentVersion);
  const desiredStableRevert =
    channel === 'stable' &&
    semver.valid(currentVersion) !== null &&
    semver.prerelease(currentVersion) !== null;

  return UPDATE_PACKAGES.map((pkg) => {
    const cached = cache.packages[pkg.id];
    const installedVersion = installedVersions[pkg.id];
    const latestStableRaw = cached?.latest_stable ?? null;
    // `latest_stable ?? currentVersion` — mirrors upgrade/checker.ts convention
    // so the revert/update logic always has a clean comparison base.
    const latestStable = latestStableRaw ?? currentVersion;
    const latestBeta = cached?.latest_beta ?? null;
    const latestVersion = cached
      ? resolveTargetFromCache(latestStable, latestBeta, channel)
      : null;

    const updateAvailable =
      installedVersion !== null &&
      latestVersion !== null &&
      semver.valid(installedVersion) !== null &&
      semver.valid(latestVersion) !== null &&
      semver.gt(latestVersion, installedVersion);

    // Mirrors the live revert gate in upgrade/checker.ts (`latest_stable != null`).
    // It stays behaviorally equivalent ONLY because the same `?? currentVersion`
    // fallback is applied consistently: the cache writer stores
    // `latest_stable ?? currentVersion`, and `latestVersion` (compared below)
    // derives from `latestStable` (the fallback value), not the raw null. Gating
    // on `latestStableRaw` here keeps this in lockstep with checker.ts — if a
    // future change stored the raw null instead, this gate must be revisited so
    // the two paths don't silently diverge.
    const revertAvailable =
      pkg.id === 'myco' &&
      desiredStableRevert &&
      latestStableRaw != null &&
      latestVersion !== null &&
      latestVersion !== currentVersion &&
      !updateAvailable;

    return {
      id: pkg.id,
      display_name: pkg.displayName,
      package_name: pkg.packageName,
      installed: installedVersion !== null,
      installed_version: installedVersion,
      latest_version: latestVersion,
      latest_stable: latestStableRaw,
      latest_beta: latestBeta,
      update_available: updateAvailable,
      revert_available: revertAvailable,
    };
  });
}

function buildCheckResultFromCache(
  currentVersion: string,
  cache: CachedCheck,
  config: UpdateConfig,
  channel: ReleaseChannel,
  error: string | null,
): CheckResult {
  const packages = buildPackagesFromCache(currentVersion, cache, channel);
  const primaryPackage = packages.find((pkg) => pkg.id === 'myco');
  // `latest_stable ?? currentVersion` ensures a clean base for comparisons.
  const latestStable = primaryPackage?.latest_stable ?? currentVersion;
  const targetVersion = primaryPackage?.latest_version ?? currentVersion;
  const latestBeta = primaryPackage?.latest_beta ?? null;
  const updateAvailable = packages.some((pkg) => pkg.installed && pkg.update_available);
  const revertAvailable = packages.some((pkg) => pkg.revert_available);

  return {
    update_available: updateAvailable,
    revert_available: revertAvailable,
    running_version: currentVersion,
    latest_version: targetVersion,
    latest_stable: latestStable,
    latest_beta: latestBeta,
    channel,
    channel_scope: 'machine',
    runtime_scope: 'machine',
    check_interval_hours: config.check_interval_hours,
    last_check: cache.checked_at,
    error,
    packages,
  };
}

/**
 * Build a CheckResult from cached data without hitting the registry.
 * Returns null when no cache exists.
 */
function statusFromCacheLocal(
  currentVersion: string,
  channelOverride?: ReleaseChannel,
  cache?: CachedCheck | null,
  config?: UpdateConfig,
): CheckResult | null {
  const resolvedCache = cache !== undefined ? cache : readCachedCheck();
  if (resolvedCache === null) return null;
  const resolvedConfig = config !== undefined ? config : readUpdateConfig();
  const effectiveChannel = channelOverride ?? resolvedCache.channel ?? resolvedConfig.channel;
  return buildCheckResultFromCache(
    currentVersion,
    resolvedCache,
    resolvedConfig,
    effectiveChannel,
    null,
  );
}

/** Persist a fresh check result to the cache file (non-fatal on failure). */
function writeFreshCache(
  packages: PackageCheckResult[],
  channel: ReleaseChannel,
  currentVersion: string,
): void {
  if (packages.length === 0) return;
  const freshCache: Record<string, unknown> = {
    checked_at: new Date().toISOString(),
    channel,
    packages: {} as Record<string, unknown>,
  };
  for (const row of packages) {
    (freshCache.packages as Record<string, unknown>)[row.id] = {
      package_name: row.package_name,
      latest_stable: row.latest_stable ?? currentVersion,
      latest_beta: row.latest_beta,
    };
  }
  try {
    fs.mkdirSync(path.dirname(UPDATE_CHECK_CACHE_PATH), { recursive: true });
    fs.writeFileSync(UPDATE_CHECK_CACHE_PATH, JSON.stringify(freshCache, null, 2), 'utf-8');
  } catch {
    /* cache write failure is non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create upgrade API handlers with injected dependencies.
 *
 * Returns an object with named handlers for each upgrade endpoint.
 */
export function createUpgradeHandlers(deps: UpgradeDeps) {
  const {
    vaultDir,
    projectRoot,
    currentVersion,
    daemonPort,
    scheduleShutdown,
    globalPrefix,
    daemonStateDir,
    home,
    platform,
    localAppData,
  } = deps;
  const serviceManager = deps.serviceManager ?? getServiceManager();
  const resolveRevertRefs = deps.resolveRevertRefs ?? resolveMycoBinaryUpdateRefs;
  const stageBinaryFn = deps.stageBinary ?? stageBinary;
  const stageDeps = deps.stageDeps ?? DEFAULT_BINARY_UPDATE_DEPS;

  function readVaultSnapshot() {
    const runtimeCommand = resolveRuntimeCommand(vaultDir);
    const desiredChannel = readProjectReleaseChannel(vaultDir);
    const runtimeScope = 'machine' as const;
    const mycoBinary = runtimeCommand ?? resolveMycoBinary();
    return { runtimeCommand, desiredChannel, runtimeScope, mycoBinary };
  }

  /** Prevents multiple restart scripts from racing during the shutdown window. */
  let restartInitiated = false;

  /**
   * Returns true when the stamp file matches `version`. The stamp records the
   * version that last ran `myco update` for this project, compared against the
   * on-disk installed version (the upgrade target), not the running version.
   */
  function isStampMatching(version: string): boolean {
    try {
      const stamp = fs.readFileSync(resolveLastUpdateVersionPath(), 'utf-8').trim();
      return stamp === version;
    } catch {
      return false;
    }
  }

  /**
   * GET /api/upgrade/status — returns cached upgrade state.
   *
   * Assembles the packages[] (the `myco` row) from cache. When the cache is
   * stale, kicks off a background registry check (fire-and-forget) and
   * immediately returns the current cached value. Retains the version-sync
   * self-restart branch (spawnRestartScript + restarting/reason fields the
   * card polls).
   */
  async function handleUpgradeStatus(_req: RouteRequest): Promise<RouteResponse> {
    const snapshot = readVaultSnapshot();

    // Version-sync self-restart: the npm bootstrap package was updated under a
    // running daemon (its installed package version > the running version), so
    // converge the native binary and restart onto it. Skip when a runtime.command
    // pin is set — restarting a pinned daemon respawns the same binary and loops.
    // Restricted to the default home: the npm bootstrap converges into ~/.myco,
    // so only a daemon there should react to the npm package version. A
    // non-default home is a separate install whose binary is unrelated to the
    // npm-global package; comparing the two can never converge and would loop.
    if (globalPrefix && !restartInitiated && snapshot.runtimeCommand === null && isDefaultMycoHome(home)) {
      const installedVersion = getInstalledVersion(globalPrefix);
      if (
        installedVersion &&
        semver.valid(installedVersion) &&
        semver.valid(currentVersion) &&
        semver.gt(installedVersion, currentVersion)
      ) {
        if (updateInProgress.inFlight(daemonStateDir)) {
          return {
            body: {
              update_in_progress: true,
              running_version: currentVersion,
              installed_version: installedVersion,
            },
          };
        }
        restartInitiated = true;
        const runLocalUpdate = !isStampMatching(installedVersion);
        const serviceManagedLabel = await resolveRestartServiceLabel(serviceManager);
        spawnRestartScript({
          projectRoot, vaultDir, runLocalUpdate,
          fromVersion: currentVersion,
          toVersion: installedVersion,
          mycoBinary: snapshot.mycoBinary,
          serviceManagedLabel,
          daemonPort,
        });
        updateInProgress.write(daemonStateDir, {
          targetVersion: installedVersion,
          startedAt: Date.now(),
          initiator: 'api/update/apply',
        });
        scheduleShutdown();
        return {
          body: {
            restarting: true,
            reason: 'version_sync',
            running_version: currentVersion,
            installed_version: installedVersion,
          },
        };
      }
    }

    // Normal flow: serve cached result; refresh in background if stale.
    // Manual-channel machines skip the background refresh — they never auto-update.
    const config = readUpdateConfig();
    const cache = readCachedCheck();
    const autoEligible = !releaseChannelIsManual();

    if (autoEligible && isCacheStale(cache, config.check_interval_hours)) {
      // Fire-and-forget background refresh.
      const effectiveChannel = snapshot.desiredChannel;
      void (async () => {
        try {
          const mycoResult = await resolveMycoPackageCheck(currentVersion, effectiveChannel, currentVersion);
          writeFreshCache([mycoResult], effectiveChannel, currentVersion);
        } catch {
          /* background check failure is non-fatal */
        }
      })();
    }

    const status = statusFromCacheLocal(currentVersion, snapshot.desiredChannel, cache, config);
    if (!status) {
      return {
        body: {
          auto_eligible: autoEligible,
          update_available: false,
          revert_available: false,
          running_version: currentVersion,
          latest_version: currentVersion,
          latest_stable: currentVersion,
          latest_beta: null,
          channel: snapshot.desiredChannel,
          channel_scope: 'machine',
          runtime_scope: snapshot.runtimeScope,
          check_interval_hours: config.check_interval_hours,
          last_check: '',
          error: null,
        },
      };
    }
    return { body: { auto_eligible: autoEligible, ...status } };
  }

  /**
   * POST /api/upgrade/check — forces an immediate registry check (blocking).
   *
   * Fetches live data via resolveMycoPackageCheck, persists to cache, and
   * returns fresh data.
   */
  async function handleUpgradeCheck(_req: RouteRequest): Promise<RouteResponse> {
    const snapshot = readVaultSnapshot();
    const config = readUpdateConfig();
    const effectiveChannel = snapshot.desiredChannel;

    const fetchErrors: string[] = [];
    const packages: PackageCheckResult[] = [];

    try {
      packages.push(await resolveMycoPackageCheck(currentVersion, effectiveChannel, currentVersion));
    } catch (err) {
      fetchErrors.push(err instanceof Error ? err.message : String(err));
    }

    // Persist fresh data so the next status call serves from cache.
    writeFreshCache(packages, effectiveChannel, currentVersion);

    const primaryPackage = packages.find((pkg) => pkg.id === 'myco');
    // `latest_stable ?? currentVersion` — consistent with checker.ts convention.
    const latestStable = primaryPackage?.latest_stable ?? currentVersion;
    const targetVersion = primaryPackage?.latest_version ?? currentVersion;
    const latestBeta = primaryPackage?.latest_beta ?? null;
    const updateAvailable = packages.some((pkg) => pkg.installed && pkg.update_available);
    const revertAvailable = packages.some((pkg) => pkg.revert_available);
    const error = fetchErrors.length > 0 ? fetchErrors.join('; ') : null;

    const result: CheckResult = {
      update_available: updateAvailable,
      revert_available: revertAvailable,
      running_version: currentVersion,
      latest_version: targetVersion,
      latest_stable: latestStable,
      latest_beta: latestBeta,
      channel: effectiveChannel,
      channel_scope: 'machine',
      runtime_scope: 'machine',
      check_interval_hours: config.check_interval_hours,
      last_check: new Date().toISOString(),
      error,
      packages,
    };

    return { body: { ...result } };
  }

  /**
   * Resolve the latest release on `channel` and stage it if the versioned binary
   * is not already on disk. The adopt step requires the binary under
   * versions/<v>/, so this guarantees it exists.
   *
   * Mirrors the CLI (`cli/upgrade.ts`): resolve the channel's asset refs DIRECTLY
   * rather than via `resolveNewestStagedVersion` (whose strictly-greater scan
   * can't return a stable version below a running prerelease, and returns null
   * when the background auto-check hasn't staged anything yet).
   *
   * Shared by two callers so the resolve→stage→adopt step is expressed once:
   *   - REVERT-TO-STABLE (`'stable'`): the target is LOWER than the running
   *     prerelease; the caller's `initiateAdopt` bypasses the no-downgrade gate.
   *   - FORWARD "Upgrade & Restart": when nothing is pre-staged, stage the
   *     channel's latest NOW so the operator's explicit click upgrades
   *     immediately instead of waiting for the next background stage tick.
   *
   * Returns the resolved version, or an `{ error }` body for the 422.
   */
  async function resolveAndStageChannelTarget(channel: ReleaseChannel): Promise<
    { version: string } | { error: { error: string; message: string } }
  > {
    let refs: AssetRefs | null;
    try {
      refs = await resolveRevertRefs(channel);
    } catch (err) {
      return {
        error: {
          error: 'release_resolve_failed',
          message: `Could not resolve the ${channel} release: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    if (refs === null) {
      return {
        error: {
          error: 'no_release_available',
          message: `No ${channel} release is available.`,
        },
      };
    }

    const vBinPath = versionBinaryPath(home, platform, refs.targetVersion, localAppData);
    if (!fs.existsSync(vBinPath)) {
      const staged = await stageBinaryFn({ refs, home, platform, localAppData }, stageDeps);
      if ('error' in staged) {
        return {
          error: {
            error: 'stage_failed',
            message: `Could not stage the ${channel} release ${refs.targetVersion}: ${staged.error}`,
          },
        };
      }
    }

    return { version: refs.targetVersion };
  }

  /**
   * POST /api/upgrade/apply — initiates the upgrade and schedules shutdown.
   *
   * For the myco binary:
   *   - FORWARD upgrade / enter-beta: drives initiateAdopt on the newest staged
   *     version strictly greater than current (staged by the background
   *     auto-check+stage job). Returns 422 when nothing has been staged yet.
   *   - REVERT-TO-STABLE (running a prerelease, channel→stable): the stable
   *     target is a LOWER version than the running prerelease, so the
   *     strictly-greater staged scan can never find it (and the strictly-greater
   *     auto-stage path never staged it either). This path mirrors the CLI:
   *     resolve the stable channel's refs DIRECTLY, stage them if not already
   *     present, then initiateAdopt that exact version — intentionally bypassing
   *     the no-downgrade gate for the explicit revert.
   *
   * Returns 400 when no update is available or when in dev mode.
   * Returns 409 when an update is already in flight.
   * Returns 422 when a forward myco update is requested but nothing is staged,
   * or when the revert-to-stable target cannot be resolved/staged.
   */
  async function handleUpgradeApply(_req: RouteRequest): Promise<RouteResponse> {
    const snapshot = readVaultSnapshot();
    const status = statusFromCacheLocal(currentVersion, snapshot.desiredChannel);
    if (!status) {
      return { status: 400, body: { error: 'no_update_available' } };
    }

    const mycoPackage = status.packages.find((pkg) => pkg.id === 'myco');

    // Myco binary swap is needed for a forward update, a revert-to-stable, a
    // channel switch onto beta, OR a channel switch back onto stable while the
    // running binary is still a prerelease.
    const mycoNeedsUpdate = Boolean(
      mycoPackage?.installed && (mycoPackage.update_available || mycoPackage.revert_available),
    );
    const enteringBeta = status.channel === 'beta';
    // Revert-to-stable: running a prerelease while the desired channel is stable.
    // The stable target is LOWER than the running prerelease, so it is resolved
    // and staged directly (see resolveStableRevertTarget) rather than via the
    // strictly-greater staged scan the forward path uses.
    const enteringStable =
      status.channel === 'stable' && semver.prerelease(currentVersion) !== null;
    const mycoNeedsBinarySwap = mycoNeedsUpdate || enteringBeta || enteringStable;

    if (!mycoNeedsBinarySwap) {
      return { status: 400, body: { error: 'no_update_available' } };
    }

    if (updateInProgress.inFlight(daemonStateDir)) {
      return { status: 409, body: { error: 'update_in_progress' } };
    }

    // Resolve the version the myco binary should adopt.
    //
    // REVERT-TO-STABLE: resolve the stable channel's refs directly (mirroring
    // the CLI's resolve→stage→adopt), stage them if not already present, and
    // adopt that exact version — even when it is LOWER than the running
    // prerelease. This is the only path that bypasses the no-downgrade gate.
    //
    // FORWARD / enter-beta: adopt the newest version strictly greater than
    // current that the background auto-check has already staged.
    let mycoTargetVersion: string | null = null;
    if (mycoNeedsBinarySwap) {
      if (enteringStable) {
        const resolved = await resolveAndStageChannelTarget('stable');
        if ('error' in resolved) {
          return { status: 422, body: resolved.error };
        }
        mycoTargetVersion = resolved.version;
      } else {
        // Prefer a version the background auto-check already staged (fast adopt).
        // If none is staged yet — the common case right after a release, before
        // the next background tick — resolve + stage the channel's latest NOW so
        // the operator's explicit "Upgrade & Restart" upgrades on the spot
        // instead of bailing with "try again in a moment".
        mycoTargetVersion = resolveNewestStagedVersion(home, platform, currentVersion, localAppData);
        if (mycoTargetVersion === null) {
          const resolved = await resolveAndStageChannelTarget(snapshot.desiredChannel);
          if ('error' in resolved) {
            return { status: 422, body: resolved.error };
          }
          mycoTargetVersion = resolved.version;
        }
      }
    }

    // Schema-gap guard for the one API path that intentionally bypasses the
    // no-downgrade gate (revert-to-stable): a target whose supported storage
    // format is below any local Grove's stamped version would refuse to
    // start after the swap. Forward adopts never trip this. Note the target
    // may have JUST been staged and never booted here — then its supported
    // version is unknown and the guard fails closed.
    if (
      mycoTargetVersion !== null
      && semver.valid(mycoTargetVersion) !== null
      && semver.valid(currentVersion) !== null
      && semver.lt(mycoTargetVersion, currentVersion)
    ) {
      const readVaultSchema = deps.readMaxStampedSchemaVersion ?? readMaxStampedSchemaVersion;
      const readTargetSchema = deps.readSupportedSchemaVersion ?? readSupportedSchemaVersion;
      const vaultSchema = readVaultSchema(home);
      const targetSchema = readTargetSchema(home, platform, mycoTargetVersion, localAppData);
      if (rollbackWouldCrossSchemaGap(vaultSchema, targetSchema)) {
        const refusal = new SchemaGapDowngradeError(mycoTargetVersion, vaultSchema!, targetSchema);
        return {
          status: 422,
          body: { error: refusal.code, message: refusal.message },
        };
      }
    }

    const serviceManagedLabel = await resolveRestartServiceLabel(serviceManager);
    const reportedVersion = mycoTargetVersion ?? status.latest_version;

    // Myco binary: drive initiateAdopt on the resolved (staged) version.
    if (mycoNeedsBinarySwap && mycoTargetVersion !== null) {
      updateInProgress.write(daemonStateDir, {
        targetVersion: mycoTargetVersion,
        startedAt: Date.now(),
        initiator: 'api/upgrade/apply',
      });

      await initiateAdopt({
        source: 'daemon',
        targetVersion: mycoTargetVersion,
        prevVersion: currentVersion,
        home,
        platform,
        localAppData,
        daemonPort,
        serviceManagedLabel,
        mycoBinary: snapshot.mycoBinary,
        projectRoot,
        inProgressSentinelPath: updateInProgress.sentinelPath(daemonStateDir),
      });
    }

    const reportedPackages =
      mycoNeedsBinarySwap && mycoTargetVersion ? [`${NPM_PACKAGE_NAME}@${mycoTargetVersion}`] : [];

    return {
      body: {
        status: 'applying',
        version: reportedVersion,
        packages: reportedPackages,
      },
    };
  }

  /**
   * PUT /api/upgrade/channel — switches the release channel and clears the cache.
   *
   * Returns 400 when the channel value is not in RELEASE_CHANNELS.
   */
  async function handleUpgradeChannel(req: RouteRequest): Promise<RouteResponse> {
    const parsed = ChannelBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return { status: 400, body: { error: 'invalid_channel' } };
    }

    const { channel } = parsed.data;
    const config = readUpdateConfig();

    try {
      writeProjectReleaseChannel(vaultDir, channel);
    } catch (err) {
      if (err instanceof TierConfigUnreadableError) {
        return {
          status: 422,
          body: {
            error: 'tier_config_unreadable',
            message: 'The on-disk machine config is invalid — fix or remove it before changing the channel.',
            file: err.filePath,
          },
        };
      }
      throw err;
    }
    clearCachedCheck();

    const snapshot = readVaultSnapshot();
    const channelStatus = statusFromCacheLocal(currentVersion, channel);
    if (!channelStatus) {
      return {
        body: {
          update_available: false,
          revert_available: false,
          running_version: currentVersion,
          latest_version: currentVersion,
          latest_stable: currentVersion,
          latest_beta: null,
          channel,
          channel_scope: 'machine',
          runtime_scope: snapshot.runtimeScope,
          check_interval_hours: config.check_interval_hours,
          last_check: '',
          error: null,
        },
      };
    }
    return { body: { ...channelStatus } };
  }

  return {
    handleUpgradeStatus,
    handleUpgradeCheck,
    handleUpgradeApply,
    handleUpgradeChannel,
  };
}
