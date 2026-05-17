import type { DaemonLogger } from './logger.js';
import type { PowerManager } from './power.js';
import type { DaemonServer } from './server.js';
import type { DaemonServiceState } from './service-state.js';
import { reconcileSelf } from './self-reconcile.js';
import { serviceLabel, serviceVariantForState } from '../service/labels.js';
import { spawnUpdateScript } from './update-installer.js';
import {
  resolveMycoBinary,
  readUpdateError,
  consumeUpdateError,
} from './update-checker.js';
import { detectServiceManagedLabel } from './api/restart.js';
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
          installUpdate: (target: string) => installUpdateToVersion(deps, target),
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

// Restart shell command the post-install script invokes after npm install.
// Mirrors createUpdateHandlers — both flows must agree on the supervisor
// so the post-install respawn lands on the same path.
async function resolveServiceRestartCommandForInstall(): Promise<string | undefined> {
  const serviceManager = getServiceManager();
  const label = await detectServiceManagedLabel(serviceManager);
  if (!label) return undefined;
  try { return serviceManager.restartShellCommand(label); } catch { return undefined; }
}

async function installUpdateToVersion(
  deps: SelfReconcileWiringDeps,
  targetVersion: string,
): Promise<void> {
  const mycoBinary = resolveMycoBinary();
  const serviceRestartCommand = await resolveServiceRestartCommandForInstall();
  spawnUpdateScript({
    packageSpecs: [`${NPM_PACKAGE_NAME}@${targetVersion}`],
    projectRoot: deps.projectRoot,
    vaultDir: deps.daemonVaultDir,
    mycoBinary,
    serviceRestartCommand,
  });
  deps.scheduleShutdown();
}
