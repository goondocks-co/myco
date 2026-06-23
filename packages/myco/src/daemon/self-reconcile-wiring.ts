import type { DaemonLogger } from './logger.js';
import type { DaemonServer } from './server.js';
import type { DaemonServiceState } from './service-state.js';
import type { DaemonStateAuthority } from './daemon-state-authority.js';
import path from 'node:path';
import { reconcileSelf } from './self-reconcile.js';
import { serviceLabel } from '../service/labels.js';
import { getServiceManager } from '../service/manager.js';
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
 * Single-flight guard: a slow reconcile tick must not start a second tick
 * before the first completes.
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
  const label = serviceLabel(path.dirname(daemonService.stateDir));
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

