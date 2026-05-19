import type { DaemonLogger } from './logger.js';
import type { PowerManager } from './power.js';
import type { DaemonServer } from './server.js';
import type { DaemonServiceState } from './service-state.js';
import { reconcileSelf } from './self-reconcile.js';
import { serviceLabel, serviceVariantForState } from '../service/labels.js';
import { spawnUpdateScript } from './update-installer.js';
import * as updateInProgress from './update-in-progress.js';
import {
  resolveMycoBinary,
  readUpdateError,
  consumeUpdateError,
} from './update-checker.js';
import { resolveServiceRestartCommand } from './api/restart.js';
import { getServiceManager } from '../service/manager.js';
import { NPM_PACKAGE_NAME } from '../constants/update.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { POWER_JOB_NAMES } from '@myco/constants/power-jobs.js';

export interface SelfReconcileWiringDeps {
  daemonService: DaemonServiceState;
  /** Live server handle. `server.currentDaemonState()` projects in-memory truth back into daemon.json each tick. */
  server: DaemonServer;
  daemonVaultDir: string;
  /** Project root the daemon was launched against; baked into update scripts for the post-install respawn. */
  projectRoot: string;
  /** In-process shutdown so the update script's `sleep && npm install` lands while the daemon is gone. */
  scheduleShutdown: () => void;
}

/**
 * Registers the SELF_RECONCILE PowerManager job. Runs first so the
 * `pid alive ⇔ daemon.json exists` invariant tick still fires even if
 * later jobs starve the tick budget. Excludes deep_sleep — the daemon
 * is essentially stopped there and we don't want filesystem writes
 * contending with system sleep.
 */
export function registerSelfReconcileJob(
  powerManager: PowerManager,
  logger: DaemonLogger,
  deps: SelfReconcileWiringDeps,
): void {
  // Single-flight guard: PowerManager.tick awaits each registered job
  // sequentially within a tick, so single-tick re-entry can't happen,
  // but a slow reconcileSelf could overlap a fresh tick if the cadence
  // tightens or installUpdate's pre-spawn work blocks beyond an interval.
  // Mirrors the running-flag pattern in team-sync-init's team-sync-flush.
  let running = false;
  powerManager.register({
    name: POWER_JOB_NAMES.SELF_RECONCILE,
    runIn: ['active', 'idle', 'sleep'],
    fn: async () => {
      if (running) return;
      running = true;
      try {
        await reconcileSelf({
          daemonService: deps.daemonService,
          currentState: () => deps.server.currentDaemonState(),
          logger,
          requestSupervisorRestart: () => requestSupervisorRestart(logger, deps.daemonService),
          installUpdate: (target: string) => runUpdateInstall(deps, target),
          readUpdateError,
          consumeUpdateError,
        });
      } finally {
        running = false;
      }
    },
  });
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
  // Don't fire a redundant installer if `/api/update/apply` or a
  // prior self-reconcile tick already has one in flight. Without
  // this guard, a slow install + multiple PowerManager ticks can
  // produce N installers in rapid succession (the trace's bounce
  // #3 shape).
  if (updateInProgress.inFlight(deps.daemonService.stateDir)) {
    return;
  }
  const mycoBinary = resolveMycoBinary();
  const serviceRestartCommand = await resolveServiceRestartCommand(getServiceManager());
  spawnUpdateScript({
    packageSpecs: [`${NPM_PACKAGE_NAME}@${targetVersion}`],
    projectRoot: deps.projectRoot,
    vaultDir: deps.daemonVaultDir,
    mycoBinary,
    serviceRestartCommand,
    daemonPort: deps.server.port,
    targetVersion,
  });
  updateInProgress.write(deps.daemonService.stateDir, {
    targetVersion,
    startedAt: Date.now(),
    initiator: 'self-reconcile',
  });

  // When the service manager will drive the restart, skip the
  // immediate SIGTERM here. Same reasoning as in handleUpdateApply:
  // a SIGTERM before `npm install` completes lets launchd respawn
  // a ghost daemon on the old binary in the gap.
  if (!serviceRestartCommand) {
    deps.scheduleShutdown();
  }
}
