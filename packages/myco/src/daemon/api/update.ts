/**
 * Update API handlers — status, manual check, apply, and channel switch.
 *
 * Factory function injects vaultDir, projectRoot, currentVersion, and a
 * scheduleShutdown callback; returns handlers for:
 *   GET  /api/update/status
 *   POST /api/update/check
 *   POST /api/update/apply
 *   PUT  /api/update/channel
 */

import { z } from 'zod';

import {
  isUpdateExempt,
  checkForUpdate,
  statusFromCache,
  readCachedCheck,
  readUpdateConfig,
  readProjectReleaseChannel,
  writeProjectReleaseChannel,
  clearCachedCheck,
  isCacheStale,
  getInstalledVersion,
  resolveMycoBinary,
  resolveRuntimeCommand,
  isManagedMachineRuntime,
} from '../update-checker.js';
import { spawnUpdateScript, spawnRestartScript } from '../update-installer.js';
import * as updateInProgress from '../update-in-progress.js';
import { RELEASE_CHANNELS, UPDATE_STAMP_FILENAME } from '../../constants/update.js';
import { resolveServiceRestartCommand } from './restart.js';
import { getServiceManager } from '../../service/manager.js';
import type { ServiceManager } from '../../service/types.js';
import semver from 'semver';
import fs from 'node:fs';
import path from 'node:path';
import type { RouteRequest, RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected by the daemon when registering update routes. */
export interface UpdateDeps {
  /** Absolute path to the active vault directory. */
  vaultDir: string;
  /** Absolute path to the project root (used by `myco update --project`). */
  projectRoot: string;
  /** The currently running version (from package.json at startup). */
  currentVersion: string;
  /**
   * Canonical port the running daemon is listening on. Baked into the
   * detached update / restart scripts so their post-install readiness
   * guard can probe /health without re-discovering the port.
   */
  daemonPort: number;
  /** Callback that schedules a graceful daemon shutdown after the update script spawns. */
  scheduleShutdown: () => void;
  /** npm global prefix, resolved once at daemon startup. Null if resolution failed. */
  globalPrefix: string | null;
  /** Daemon state directory (`<myco-home>/<variant>/`). The update-in-
   *  progress sentinel lives here as a sibling to `daemon.json`. */
  daemonStateDir: string;
  /** Optional override for tests; defaults to the platform service manager.
   *  Used to detect whether this process is the service-managed daemon and
   *  to derive the restart-shell-command baked into the detached update /
   *  restart script. */
  serviceManager?: ServiceManager;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const ChannelBodySchema = z.object({
  channel: z.enum(RELEASE_CHANNELS),
});

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create update API handlers with injected dependencies.
 *
 * Returns an object with named handlers for each update endpoint.
 */
export function createUpdateHandlers(deps: UpdateDeps) {
  const { vaultDir, projectRoot, currentVersion, daemonPort, scheduleShutdown, globalPrefix, daemonStateDir } = deps;
  const serviceManager = deps.serviceManager ?? getServiceManager();

  /**
   * Per-request snapshot of everything derived from vault state on disk.
   * Reads each source once per handler invocation; handlers pass the
   * snapshot into all downstream helpers instead of re-reading.
   */
  function readVaultSnapshot() {
    const runtimeCommand = resolveRuntimeCommand(vaultDir);
    const desiredChannel = readProjectReleaseChannel(vaultDir);
    const runtimeScope: 'managed' | 'machine' =
      runtimeCommand !== null && isManagedMachineRuntime(runtimeCommand)
        ? 'managed'
        : 'machine';
    const mycoBinary = runtimeCommand ?? resolveMycoBinary();
    return { runtimeCommand, desiredChannel, runtimeScope, mycoBinary };
  }

  /** Prevents multiple restart scripts from racing during the shutdown window. */
  let restartInitiated = false;

  /**
   * Returns true when the stamp file matches `version`. The stamp records the
   * version that last ran `myco update` for this project, so callers should
   * compare it against the version the daemon is upgrading to (the on-disk
   * installed version) — not the running version, which is the version we are
   * leaving behind.
   */
  function isStampMatching(version: string): boolean {
    try {
      const stampPath = path.join(vaultDir, UPDATE_STAMP_FILENAME);
      const stamp = fs.readFileSync(stampPath, 'utf-8').trim();
      return stamp === version;
    } catch {
      return false;
    }
  }

  /**
   * GET /api/update/status — returns cached update state.
   *
   * When the cache is stale, kicks off a background registry check
   * (fire-and-forget) and immediately returns the current cached value.
   */
  async function handleUpdateStatus(_req: RouteRequest): Promise<RouteResponse> {
    if (isUpdateExempt()) {
      return { body: { exempt: true, running_version: currentVersion } };
    }

    const snapshot = readVaultSnapshot();

    // Installed-version check — short-circuits before the registry call
    // and only when there is NO `runtime.command` pin. A pin means the
    // daemon is locked to a specific binary (beta runtimes under
    // `.myco/runtime/`, dogfood symlinks like ~/.local/bin/myco-dev, or
    // any other user-set pin). `npm install -g` never touches those
    // binaries, so respawning via the pin re-execs the same binary and
    // loops. Pinned-runtime updates flow through handleUpdateApply.
    if (globalPrefix && !restartInitiated && snapshot.runtimeCommand === null) {
      const installedVersion = getInstalledVersion(globalPrefix);
      if (
        installedVersion &&
        semver.valid(installedVersion) &&
        semver.valid(currentVersion) &&
        semver.gt(installedVersion, currentVersion)
      ) {
        // Don't fire a redundant restart if an update orchestrator is
        // already in flight. The sentinel module clears stale entries
        // (>10 min) so a crashed updater can't block future restarts.
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
        const serviceRestartCommand = await resolveServiceRestartCommand(serviceManager);
        spawnRestartScript({
          projectRoot, vaultDir, runLocalUpdate,
          fromVersion: currentVersion,
          toVersion: installedVersion,
          mycoBinary: snapshot.mycoBinary,
          serviceRestartCommand,
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

    // --- Normal registry check flow (unchanged) ---
    const config = readUpdateConfig();
    const cache = readCachedCheck();

    if (isCacheStale(cache, config.check_interval_hours)) {
      // Fire-and-forget — don't block the response on the registry fetch.
      checkForUpdate(
        currentVersion,
        globalPrefix,
        snapshot.runtimeCommand,
        snapshot.desiredChannel,
      ).catch(() => {});
    }

    // Pass pre-read config and cache to avoid reading the files a second time.
    const status = statusFromCache(
      currentVersion,
      cache,
      config,
      globalPrefix,
      snapshot.runtimeCommand,
      snapshot.desiredChannel,
    );
    if (!status) {
      // No cache yet — return minimal response; background check will populate it.
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
          channel_scope: 'project',
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
   * POST /api/update/check — forces an immediate registry check (blocking).
   *
   * Intended for user-initiated "Check Now" actions where the caller wants
   * fresh data before rendering.
   */
  async function handleUpdateCheck(_req: RouteRequest): Promise<RouteResponse> {
    if (isUpdateExempt()) {
      return {
        status: 400,
        body: { error: 'update_exempt', message: 'Updates disabled in dev mode' },
      };
    }

    const snapshot = readVaultSnapshot();
    const result = await checkForUpdate(
      currentVersion,
      globalPrefix,
      snapshot.runtimeCommand,
      snapshot.desiredChannel,
    );
    return { body: { exempt: false, ...result } };
  }

  /**
   * POST /api/update/apply — spawns the update script and schedules shutdown.
   *
   * Returns 400 when no update is available or when in dev mode.
   */
  async function handleUpdateApply(_req: RouteRequest): Promise<RouteResponse> {
    if (isUpdateExempt()) {
      return { status: 400, body: { error: 'update_exempt' } };
    }

    const snapshot = readVaultSnapshot();
    const status = statusFromCache(
      currentVersion,
      undefined,
      undefined,
      globalPrefix,
      snapshot.runtimeCommand,
      snapshot.desiredChannel,
    );
    if (!status) {
      return { status: 400, body: { error: 'no_update_available' } };
    }

    const mycoPackage = status.packages.find((pkg) => pkg.id === 'myco');
    const mycoPackageSpec = mycoPackage?.latest_version
      ? `${mycoPackage.package_name}@${mycoPackage.latest_version}`
      : undefined;

    // Specs to `npm install -g` — covers both forward updates and revert
    // flows. For a revert, we reinstall the stable target globally so the
    // machine runtime is at the correct version before we drop the
    // project-local runtime.
    const installSpecs = status.packages
      .filter(
        (pkg) => pkg.installed && (pkg.update_available || pkg.revert_available) && pkg.latest_version,
      )
      .map((pkg) => `${pkg.package_name}@${pkg.latest_version}`);

    // Reverting a managed beta runtime back to the global stable install.
    const removeLocalRuntime =
      status.channel === 'stable' && snapshot.runtimeScope === 'managed';

    // Entering beta on a machine still on the global runtime means we need
    // to install a managed runtime — even when the global install is already
    // at the beta target version and `update_available` is false.
    const enteringBetaLocalRuntime =
      status.channel === 'beta' && snapshot.runtimeScope === 'machine';

    const localRuntimeSpec = (() => {
      if (enteringBetaLocalRuntime) return mycoPackageSpec;
      if (status.channel === 'beta') {
        return installSpecs.find((spec) => spec.startsWith('@goondocks/myco@'));
      }
      return undefined;
    })();

    if (installSpecs.length === 0 && !removeLocalRuntime && !localRuntimeSpec) {
      return { status: 400, body: { error: 'no_update_available' } };
    }

    // Refuse a second apply while an update is already in flight. The
    // sentinel auto-clears after a 10-minute stale window so a crashed
    // updater can't block future updates forever.
    if (updateInProgress.inFlight(daemonStateDir)) {
      return { status: 409, body: { error: 'update_in_progress' } };
    }

    const globalPackageSpecs = localRuntimeSpec
      ? installSpecs.filter((spec) => spec !== localRuntimeSpec)
      : installSpecs;

    const serviceRestartCommand = await resolveServiceRestartCommand(serviceManager);
    spawnUpdateScript({
      packageSpecs: globalPackageSpecs,
      localRuntimeSpec,
      removeLocalRuntime,
      projectRoot,
      vaultDir,
      mycoBinary: snapshot.mycoBinary,
      serviceRestartCommand,
      daemonPort,
      targetVersion: status.latest_version,
    });
    updateInProgress.write(daemonStateDir, {
      targetVersion: status.latest_version,
      startedAt: Date.now(),
      initiator: 'api/update/apply',
    });

    // When a service manager is going to drive the restart (the
    // script's tail uses `launchctl kickstart -k` or equivalent),
    // we must NOT also schedule an immediate SIGTERM here. Doing so
    // shuts the daemon down before the script's `npm install`
    // completes, which lets the supervisor's KeepAlive respawn a
    // ghost daemon on the OLD binary in the gap — the trace's
    // bounce #1 shape. The daemon keeps running on its mmap'd
    // binary file through `npm install`; the script's restart tail
    // sends the actual SIGTERM as part of the swap. Without a
    // service manager, the script can't initiate the SIGTERM itself
    // so the caller must do it.
    if (!serviceRestartCommand) {
      scheduleShutdown();
    }

    const reportedPackages = localRuntimeSpec && !installSpecs.includes(localRuntimeSpec)
      ? [...installSpecs, localRuntimeSpec]
      : installSpecs;

    return {
      body: {
        status: 'applying',
        version: status.latest_version,
        packages: reportedPackages,
      },
    };
  }

  /**
   * PUT /api/update/channel — switches the release channel and clears the cache.
   *
   * Returns 400 when the channel value is not in RELEASE_CHANNELS.
   */
  async function handleUpdateChannel(req: RouteRequest): Promise<RouteResponse> {
    const parsed = ChannelBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return { status: 400, body: { error: 'invalid_channel' } };
    }

    const { channel } = parsed.data;
    const config = readUpdateConfig();

    writeProjectReleaseChannel(vaultDir, channel);
    clearCachedCheck();

    const snapshot = readVaultSnapshot();
    const channelStatus = statusFromCache(
      currentVersion,
      undefined,
      undefined,
      globalPrefix,
      snapshot.runtimeCommand,
      channel,
    );
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
          channel_scope: 'project',
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
    handleUpdateStatus,
    handleUpdateCheck,
    handleUpdateApply,
    handleUpdateChannel,
  };
}
