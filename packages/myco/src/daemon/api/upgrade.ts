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
 * Union recompose (owned here — moved from update-checker shim per Task 7):
 *   status assembles packages[] = [myco from cache, ...operators from cache].
 *   check uses resolveMycoPackageCheck + checkOperatorCliVersions (live fetch),
 *   then persists to cache.
 * The myco apply path drives initiateAdopt (staged binary) directly.
 * Version-sync self-restart (spawnRestartScript + restarting/reason) is retained.
 */

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';

import {
  isUpdateExempt,
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
import { spawnUpdateScript, spawnRestartScript } from '@myco/upgrade/spawn.js';
import { initiateAdopt } from '@myco/upgrade/adopt.js';
import { resolveMycoPackageCheck } from '@myco/upgrade/checker.js';
import type { PackageCheckResult } from '@myco/upgrade/checker.js';
import { checkOperatorCliVersions } from '../operator-cli-versions.js';
import * as updateInProgress from '@myco/upgrade/in-progress.js';
import { resolveNewestStagedVersion } from '@myco/upgrade/auto-check.js';
import {
  RELEASE_CHANNELS,
  NPM_PACKAGE_NAME,
  UPDATE_PACKAGES,
  UPDATE_CHECK_CACHE_PATH,
} from '../../constants/update.js';
import type { ReleaseChannel, UpdatePackageId } from '../../constants/update.js';
import { resolveLastUpdateVersionPath } from '../../grove/paths.js';
import { detectServiceManagedLabel } from './restart.js';
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
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const ChannelBodySchema = z.object({
  channel: z.enum(RELEASE_CHANNELS),
});

// ---------------------------------------------------------------------------
// Union assembly helpers (owned here — moved from update-checker shim)
// ---------------------------------------------------------------------------

function buildInstalledVersions(
  globalPrefix: string | null,
  currentVersion: string,
): Record<UpdatePackageId, string | null> {
  const installed: Record<UpdatePackageId, string | null> = {
    myco: currentVersion,
    'myco-team': null,
    'myco-collective': null,
  };
  if (globalPrefix === null) return installed;
  for (const pkg of UPDATE_PACKAGES) {
    if (pkg.id === 'myco') continue;
    installed[pkg.id] = getInstalledVersion(globalPrefix, pkg.packageName);
  }
  return installed;
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
  globalPrefix: string | null,
): PackageCheckResult[] {
  const installedVersions = buildInstalledVersions(globalPrefix, currentVersion);
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
  globalPrefix: string | null,
): CheckResult {
  const packages = buildPackagesFromCache(currentVersion, cache, channel, globalPrefix);
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
  globalPrefix: string | null,
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
    globalPrefix,
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
   * Assembles the union packages[] = [myco, ...operators] from cache.
   * When the cache is stale, kicks off a background registry check
   * (fire-and-forget) and immediately returns the current cached value.
   * Retains the version-sync self-restart branch (spawnRestartScript +
   * restarting/reason fields the card polls).
   */
  async function handleUpgradeStatus(_req: RouteRequest): Promise<RouteResponse> {
    if (isUpdateExempt()) {
      return { body: { exempt: true, running_version: currentVersion } };
    }

    const snapshot = readVaultSnapshot();

    // Version-sync self-restart: when the globally-installed myco is newer
    // than the running daemon (npm updated it while the daemon was running),
    // respawn via the managed binary path. Skip when a runtime.command pin
    // is set — restarting a pinned daemon would respawn the same binary and loop.
    if (globalPrefix && !restartInitiated && snapshot.runtimeCommand === null) {
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
              exempt: false,
              update_in_progress: true,
              running_version: currentVersion,
              installed_version: installedVersion,
            },
          };
        }
        restartInitiated = true;
        const runLocalUpdate = !isStampMatching(installedVersion);
        const serviceManagedLabel = await detectServiceManagedLabel(serviceManager);
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

    // Normal flow: serve cached union result; refresh in background if stale.
    const config = readUpdateConfig();
    const cache = readCachedCheck();

    if (isCacheStale(cache, config.check_interval_hours)) {
      // Fire-and-forget background refresh using the new split checkers.
      const effectiveChannel = snapshot.desiredChannel;
      void (async () => {
        try {
          const installedVersions = buildInstalledVersions(globalPrefix, currentVersion);
          const [mycoResult, operatorResult] = await Promise.allSettled([
            resolveMycoPackageCheck(currentVersion, effectiveChannel, currentVersion),
            checkOperatorCliVersions(effectiveChannel, installedVersions),
          ]);
          const freshPkgs: PackageCheckResult[] = [];
          if (mycoResult.status === 'fulfilled') freshPkgs.push(mycoResult.value);
          if (operatorResult.status === 'fulfilled') freshPkgs.push(...operatorResult.value);
          writeFreshCache(freshPkgs, effectiveChannel, currentVersion);
        } catch {
          /* background check failure is non-fatal */
        }
      })();
    }

    const status = statusFromCacheLocal(currentVersion, globalPrefix, snapshot.desiredChannel, cache, config);
    if (!status) {
      return {
        body: {
          exempt: false,
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
    return { body: { exempt: false, ...status } };
  }

  /**
   * POST /api/upgrade/check — forces an immediate registry check (blocking).
   *
   * Fetches live data via resolveMycoPackageCheck + checkOperatorCliVersions,
   * assembles the union CheckResult, persists to cache, and returns fresh data.
   */
  async function handleUpgradeCheck(_req: RouteRequest): Promise<RouteResponse> {
    if (isUpdateExempt()) {
      return {
        status: 400,
        body: { error: 'update_exempt', message: 'Updates disabled in dev mode' },
      };
    }

    const snapshot = readVaultSnapshot();
    const config = readUpdateConfig();
    const effectiveChannel = snapshot.desiredChannel;
    const installedVersions = buildInstalledVersions(globalPrefix, currentVersion);

    const [mycoSettled, operatorSettled] = await Promise.allSettled([
      resolveMycoPackageCheck(currentVersion, effectiveChannel, currentVersion),
      checkOperatorCliVersions(effectiveChannel, installedVersions),
    ]);

    const fetchErrors: string[] = [];
    const packages: PackageCheckResult[] = [];

    if (mycoSettled.status === 'fulfilled') {
      packages.push(mycoSettled.value);
    } else {
      const msg = mycoSettled.reason instanceof Error
        ? mycoSettled.reason.message
        : String(mycoSettled.reason);
      fetchErrors.push(msg);
    }

    if (operatorSettled.status === 'fulfilled') {
      packages.push(...operatorSettled.value);
    } else {
      const msg = operatorSettled.reason instanceof Error
        ? operatorSettled.reason.message
        : String(operatorSettled.reason);
      fetchErrors.push(msg);
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

    return { body: { exempt: false, ...result } };
  }

  /**
   * POST /api/upgrade/apply — initiates the upgrade and schedules shutdown.
   *
   * For the myco binary: drives initiateAdopt on the staged version (staged
   * by the background auto-check+stage job). Returns 422 when no staged
   * version is available yet (background check hasn't run).
   * For operator CLIs (myco-team / myco-collective): uses spawnUpdateScript
   * (npm path), the same as before.
   *
   * Returns 400 when no update is available or when in dev mode.
   * Returns 409 when an update is already in flight.
   * Returns 422 when myco update is requested but no staged version is found.
   */
  async function handleUpgradeApply(_req: RouteRequest): Promise<RouteResponse> {
    if (isUpdateExempt()) {
      return { status: 400, body: { error: 'update_exempt' } };
    }

    const snapshot = readVaultSnapshot();
    const status = statusFromCacheLocal(currentVersion, globalPrefix, snapshot.desiredChannel);
    if (!status) {
      return { status: 400, body: { error: 'no_update_available' } };
    }

    const mycoPackage = status.packages.find((pkg) => pkg.id === 'myco');

    // Operator CLIs (myco-team / myco-collective) remain on npm.
    const operatorSpecs = status.packages
      .filter(
        (pkg) =>
          pkg.id !== 'myco' &&
          pkg.installed &&
          (pkg.update_available || pkg.revert_available) &&
          pkg.latest_version,
      )
      .map((pkg) => `${pkg.package_name}@${pkg.latest_version}`);

    // Myco binary swap is needed for a forward update, a revert-to-stable, a
    // channel switch onto beta, OR a channel switch back onto stable while the
    // running binary is still a prerelease.
    const mycoNeedsUpdate = Boolean(
      mycoPackage?.installed && (mycoPackage.update_available || mycoPackage.revert_available),
    );
    const enteringBeta = status.channel === 'beta';
    const enteringStable =
      status.channel === 'stable' && semver.prerelease(currentVersion) !== null;
    const mycoNeedsBinarySwap = mycoNeedsUpdate || enteringBeta || enteringStable;

    // Resolve staged version for the myco binary swap path via initiateAdopt.
    let stagedVersion: string | null = null;
    if (mycoNeedsBinarySwap) {
      stagedVersion = resolveNewestStagedVersion(home, platform, currentVersion, localAppData);
      if (stagedVersion === null) {
        return {
          status: 422,
          body: {
            error: 'no_staged_version',
            message: 'No staged version found. The background auto-check has not yet staged a binary. Try again in a moment.',
          },
        };
      }
    }

    if (operatorSpecs.length === 0 && !mycoNeedsBinarySwap) {
      return { status: 400, body: { error: 'no_update_available' } };
    }

    if (updateInProgress.inFlight(daemonStateDir)) {
      return { status: 409, body: { error: 'update_in_progress' } };
    }

    const serviceManagedLabel = await detectServiceManagedLabel(serviceManager);
    const reportedVersion = stagedVersion ?? status.latest_version;

    // Operator CLIs: spawn update script (npm path).
    if (operatorSpecs.length > 0) {
      spawnUpdateScript({
        packageSpecs: operatorSpecs,
        projectRoot,
        vaultDir,
        mycoBinary: snapshot.mycoBinary,
        serviceManagedLabel,
        daemonPort,
        targetVersion: status.latest_version,
        mycoBinaryUpdate: undefined,
        inProgressSentinelPath: updateInProgress.sentinelPath(daemonStateDir),
      });
      if (!serviceManagedLabel) {
        scheduleShutdown();
      }
    }

    // Myco binary: drive initiateAdopt on the staged version.
    if (mycoNeedsBinarySwap && stagedVersion !== null) {
      updateInProgress.write(daemonStateDir, {
        targetVersion: stagedVersion,
        startedAt: Date.now(),
        initiator: 'api/update/apply',
      });

      await initiateAdopt({
        source: 'daemon',
        targetVersion: stagedVersion,
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

    const reportedPackages = [
      ...(mycoNeedsBinarySwap && stagedVersion ? [`${NPM_PACKAGE_NAME}@${stagedVersion}`] : []),
      ...operatorSpecs,
    ];

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
    const channelStatus = statusFromCacheLocal(currentVersion, globalPrefix, channel);
    if (!channelStatus) {
      return {
        body: {
          exempt: false,
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
    return { body: { exempt: false, ...channelStatus } };
  }

  return {
    handleUpgradeStatus,
    handleUpgradeCheck,
    handleUpgradeApply,
    handleUpgradeChannel,
  };
}
