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
import { TierConfigUnreadableError } from '../../config/loader.js';
import { spawnUpdateScript, spawnRestartScript } from '../update-installer.js';
import { resolveMycoBinaryUpdateRefs } from '../myco-release-resolver.js';
import type { MycoBinaryUpdateRefs } from '../apply-update.js';
import * as updateInProgress from '../update-in-progress.js';
import { RELEASE_CHANNELS, NPM_PACKAGE_NAME } from '../../constants/update.js';
import { resolveLastUpdateVersionPath } from '../../grove/paths.js';
import { detectServiceManagedLabel } from './restart.js';
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
      const stamp = fs.readFileSync(resolveLastUpdateVersionPath(), 'utf-8').trim();
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

    // Myco itself updates by BINARY SWAP (stable AND beta) — never npm. The
    // operator CLIs (myco-team / myco-collective) STAY on npm. Split the
    // packages accordingly: myco drives `mycoBinaryUpdate`, everyone else lands
    // in `packageSpecs` for `npm install -g`.
    const operatorSpecs = status.packages
      .filter(
        (pkg) =>
          pkg.id !== 'myco' &&
          pkg.installed &&
          (pkg.update_available || pkg.revert_available) &&
          pkg.latest_version,
      )
      .map((pkg) => `${pkg.package_name}@${pkg.latest_version}`);

    // A myco binary swap is needed for a forward update, a revert-to-stable, OR
    // a channel switch onto beta where the resolved beta target differs from
    // what's running (the old "enter beta even when the version matches"
    // semantic — under a binary swap this means "swap onto the beta binary").
    const mycoNeedsUpdate = Boolean(
      mycoPackage?.installed && (mycoPackage.update_available || mycoPackage.revert_available),
    );
    const enteringBeta = status.channel === 'beta' && snapshot.runtimeScope === 'machine';
    const mycoNeedsBinarySwap = mycoNeedsUpdate || enteringBeta;

    // Resolve the release refs for this channel BEFORE spawning the detached
    // orchestrator (it runs after the daemon exits and can't re-discover the
    // release). Beta resolves a prerelease; stable / revert-to-stable resolve
    // the stable release — both swap the SAME managed `~/.myco/bin/myco`.
    let mycoBinaryUpdate: MycoBinaryUpdateRefs | undefined;
    if (mycoNeedsBinarySwap) {
      try {
        mycoBinaryUpdate = (await resolveMycoBinaryUpdateRefs(status.channel)) ?? undefined;
      } catch {
        mycoBinaryUpdate = undefined;
      }
      if (!mycoBinaryUpdate) {
        return { status: 502, body: { error: 'release_resolution_failed' } };
      }
    }

    if (operatorSpecs.length === 0 && !mycoBinaryUpdate) {
      return { status: 400, body: { error: 'no_update_available' } };
    }

    // Refuse a second apply while an update is already in flight. The
    // sentinel auto-clears after a 10-minute stale window so a crashed
    // updater can't block future updates forever.
    if (updateInProgress.inFlight(daemonStateDir)) {
      return { status: 409, body: { error: 'update_in_progress' } };
    }

    const serviceManagedLabel = await detectServiceManagedLabel(serviceManager);
    // `localRuntimeSpec` / `removeLocalRuntime` are intentionally left unset for
    // the myco path: the binary swap supersedes the managed-runtime install AND
    // the revert-to-stable npm install. The legacy managed-runtime plumbing is
    // retained-but-inert (Task 9c removes it).
    spawnUpdateScript({
      packageSpecs: operatorSpecs,
      projectRoot,
      vaultDir,
      mycoBinary: snapshot.mycoBinary,
      serviceManagedLabel,
      daemonPort,
      targetVersion: status.latest_version,
      mycoBinaryUpdate,
    });
    updateInProgress.write(daemonStateDir, {
      targetVersion: status.latest_version,
      startedAt: Date.now(),
      initiator: 'api/update/apply',
    });

    // When a service manager drives the restart (kickstart -k), the
    // orchestrator does the SIGTERM as part of the atomic swap.
    // Calling scheduleShutdown here would shut the daemon down before
    // the swap / npm install completes, letting the supervisor's KeepAlive
    // respawn a daemon on the still-pre-install binary. Without a
    // service manager (null label) the orchestrator can't initiate the
    // SIGTERM itself, so the caller has to.
    if (!serviceManagedLabel) {
      scheduleShutdown();
    }

    const reportedPackages = mycoBinaryUpdate
      ? [`${NPM_PACKAGE_NAME}@${mycoBinaryUpdate.targetVersion}`, ...operatorSpecs]
      : operatorSpecs;

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
    handleUpdateStatus,
    handleUpdateCheck,
    handleUpdateApply,
    handleUpdateChannel,
  };
}
