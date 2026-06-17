import type { DaemonLogger } from './logger.js';
import type { DaemonServer } from './server.js';
import type { DaemonServiceState } from './service-state.js';
import type { DaemonStateAuthority } from './daemon-state-authority.js';
import { reconcileSelf } from './self-reconcile.js';
import { serviceLabel, serviceVariantForState } from '../service/labels.js';
import { spawnUpdateScript } from './update-installer.js';
import { resolveMycoBinaryUpdateRefsForVersion } from './myco-release-resolver.js';
import { writeFileSafe } from './apply-update.js';
import * as updateInProgress from './update-in-progress.js';
import {
  resolveMycoBinary,
  readUpdateError,
  consumeUpdateError,
} from './update-checker.js';
import { detectServiceManagedLabel } from './api/restart.js';
import { getServiceManager } from '../service/manager.js';
import { UPDATE_ERROR_PATH } from '../constants/update.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

/**
 * Cadence for the self-reconcile tick. 30s is long enough to be
 * invisible in the log, short enough that a `daemon.json` deleted
 * out-of-band heals well within one rendezvous window of any caller
 * that reads it directly (CLI, UI, `myco doctor`).
 */
const SELF_RECONCILE_INTERVAL_MS = 30_000;

export interface SelfReconcileWiringDeps {
  daemonService: DaemonServiceState;
  /** The single capability that mutates daemon.json. Passed through to reconcileSelf. */
  stateAuthority: DaemonStateAuthority;
  /** Live server handle. `server.currentDaemonState()` projects in-memory truth back into daemon.json each tick. */
  server: DaemonServer;
  daemonVaultDir: string;
  /** Project root the daemon was launched against; baked into update scripts for the post-install respawn. */
  projectRoot: string;
  /** In-process shutdown so the update script's `sleep && npm install` lands while the daemon is gone. */
  scheduleShutdown: () => void;
}

/** Handle returned by {@link startSelfReconcileLoop}. */
export interface SelfReconcileLoopHandle {
  /** Stop the loop. Safe to call multiple times. */
  stop(): void;
}

/**
 * Start the self-reconcile loop on a dedicated `setInterval`,
 * intentionally decoupled from the PowerManager job queue.
 *
 * History: self-reconcile used to be a PowerManager job. That made it
 * the very safety net most likely to be silenced by the very condition
 * it was designed to heal — when a hot path starved the event loop and
 * PowerManager ticks stopped firing, daemon.json could go missing for
 * the daemon's entire lifetime with no log entry from this job. Running
 * on a plain `setInterval` (with `unref()` so it doesn't keep the
 * process alive on its own) means the tick continues even if every
 * other registered job is wedged.
 *
 * Single-flight guard preserved from the prior implementation: a slow
 * `installUpdate` could take longer than one interval.
 */
export function startSelfReconcileLoop(
  logger: DaemonLogger,
  deps: SelfReconcileWiringDeps,
): SelfReconcileLoopHandle {
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await reconcileSelf({
        daemonService: deps.daemonService,
        stateAuthority: deps.stateAuthority,
        currentState: () => deps.server.currentDaemonState(),
        logger,
        requestSupervisorRestart: () => requestSupervisorRestart(logger, deps.daemonService),
        installUpdate: (target: string) => runUpdateInstall(deps, target),
        readUpdateError,
        consumeUpdateError,
        updateInFlight: () => updateInProgress.inFlight(deps.daemonService.stateDir) !== null,
      });
    } catch (err) {
      logger.error(
        LOG_KINDS.DAEMON_RECONCILE,
        'self-reconcile tick threw',
        { error: errorMessage(err) },
      );
    } finally {
      running = false;
    }
  };

  // Fire one tick immediately so the post-startup daemon.json re-assert
  // happens within the first second, not 30s later.
  void tick();
  const timer = setInterval(() => { void tick(); }, SELF_RECONCILE_INTERVAL_MS);
  // unref so this interval cannot, on its own, prevent process exit.
  timer.unref();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** Fire-and-forget supervisor restart via `ServiceManager.restart(label)`. */
function requestSupervisorRestart(logger: DaemonLogger, daemonService: DaemonServiceState): void {
  const label = serviceLabel(serviceVariantForState(daemonService));
  const serviceManager = getServiceManager();
  if (!serviceManager.supported) {
    logger.warn(
      LOG_KINDS.DAEMON_RECONCILE,
      'Supervisor restart not implemented on this platform',
      { platform: process.platform, label },
    );
    return;
  }
  serviceManager.restart(label).catch((err: unknown) => {
    logger.error(
      LOG_KINDS.DAEMON_RECONCILE,
      'Supervisor restart failed',
      { platform: process.platform, label, error: errorMessage(err) },
    );
  });
}

/**
 * Spawn the detached update installer for `targetVersion` and schedule
 * daemon shutdown so the install lands while the daemon is gone. Shares
 * the supervisor-detection path with createUpdateHandlers so both flows
 * resolve the same restart-shell-command for the post-install respawn.
 */
async function runUpdateInstall(
  deps: SelfReconcileWiringDeps,
  targetVersion: string,
): Promise<void> {
  const mycoBinary = resolveMycoBinary();

  // Myco updates by BINARY SWAP — resolve the exact-version release refs for
  // this machine's platform instead of putting a myco npm spec in packageSpecs.
  // `packageSpecs` stays empty here: the `--target-version` intent path only
  // ever targets the myco core (operator CLIs are not version-pinned through
  // this channel).
  const mycoBinaryUpdate = await resolveMycoBinaryUpdateRefsForVersion(targetVersion);
  if (!mycoBinaryUpdate) {
    // No matching release / no asset for this platform. Surface via the error
    // side-channel so the next reconcile tick clears the intent (no auto-retry)
    // instead of re-resolving forever.
    writeFileSafe(
      UPDATE_ERROR_PATH,
      JSON.stringify({
        error: `no myco release asset found for ${targetVersion} on this platform — update aborted`,
      }),
    );
    return;
  }

  const serviceManagedLabel = await detectServiceManagedLabel(getServiceManager());
  spawnUpdateScript({
    packageSpecs: [],
    projectRoot: deps.projectRoot,
    vaultDir: deps.daemonVaultDir,
    mycoBinary,
    serviceManagedLabel,
    daemonPort: deps.server.port,
    targetVersion,
    mycoBinaryUpdate,
    // Forward the sentinel path so an aborted/rolled-back binary swap clears it
    // (the restored daemon comes back on the OLD version, so the daemon-startup
    // target-version clear won't fire).
    inProgressSentinelPath: updateInProgress.sentinelPath(deps.daemonService.stateDir),
  });
  updateInProgress.write(deps.daemonService.stateDir, {
    targetVersion,
    startedAt: Date.now(),
    initiator: 'self-reconcile',
  });

  // When the service manager will drive the restart, skip the
  // immediate SIGTERM here. Same reasoning as in handleUpdateApply:
  // a SIGTERM before `npm install` completes lets the supervisor
  // respawn a daemon on the still-pre-install binary. A null label means
  // non-service-managed — we must self-terminate so the respawn can claim
  // the port.
  if (!serviceManagedLabel) {
    deps.scheduleShutdown();
  }
}
