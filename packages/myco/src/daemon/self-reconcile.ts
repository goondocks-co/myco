import type { DaemonLogger } from './logger.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import {
  type DaemonServiceState,
  type DaemonState,
} from './service-state.js';
import type { DaemonStateAuthority } from './daemon-state-authority.js';
import { readIntent, clearRestartIntent } from './intent.js';

export interface ReconcileSelfDeps {
  daemonService: DaemonServiceState;
  /**
   * Capability for mutating daemon.json. The reconciler's heartbeat
   * write goes through this; raw `writeOrTouchDaemonState` is no longer
   * accessible.
   */
  stateAuthority: DaemonStateAuthority;
  currentState: () => DaemonState;
  logger: DaemonLogger;
  requestSupervisorRestart?: () => void;
}

/**
 * Continuously enforces `pid alive ⇔ daemon.json exists` and drains
 * per-section intent files.
 *
 *   [restart] (intent.restart.toml)
 *     - Clear BEFORE invoking the supervisor restart — load-bearing. A
 *       respawn that observes the intent before it is cleared would
 *       trigger an infinite restart loop.
 *
 * Binary upgrade intents ([update]) were removed in the Task 9 refactor.
 * Upgrades are now driven directly via `initiateAdopt` paths.
 */
export async function reconcileSelf(deps: ReconcileSelfDeps): Promise<void> {
  const expected = deps.currentState();
  const observed = deps.stateAuthority.read();
  if (!observed || observed.pid !== expected.pid || observed.port !== expected.port) {
    deps.logger.info(LOG_KINDS.DAEMON_RECONCILE, 'Re-asserting daemon.json from live state', {
      had_file: observed !== null,
      state_path: deps.daemonService.statePath,
      expected_pid: expected.pid,
      observed_pid: observed?.pid ?? null,
      expected_port: expected.port,
      observed_port: observed?.port ?? null,
    });
  }
  deps.stateAuthority.writeOrTouch(expected, { reason: 'self-reconcile:heartbeat' });

  const intent = readIntent(deps.daemonService);

  if (intent.restart) {
    deps.logger.info(
      LOG_KINDS.DAEMON_RECONCILE,
      'Restart intent observed; initiating supervisor restart',
      { requested_at: intent.restart.requested_at, reason: intent.restart.reason ?? null },
    );
    clearRestartIntent(deps.daemonService);
    deps.requestSupervisorRestart?.();
  }
}
