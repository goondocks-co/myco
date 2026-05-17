import type { DaemonLogger } from './logger.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import {
  readDaemonState,
  writeDaemonState,
  type DaemonServiceState,
  type DaemonState,
} from './service-state.js';
import { readIntent, clearIntentSection } from './intent.js';

export interface ReconcileSelfDeps {
  daemonService: DaemonServiceState;
  currentState: () => DaemonState;
  logger: DaemonLogger;
  requestSupervisorRestart?: () => void;
  installUpdate?: (targetVersion: string) => Promise<void>;
}

/**
 * Continuously enforces `pid alive ⇔ daemon.json exists` and drains
 * intent.toml. Two intent kinds with deliberately asymmetric clear
 * semantics:
 *   - `[restart]`: clear BEFORE invoking — load-bearing. A respawn
 *     that observes the intent before it's cleared would trigger an
 *     infinite restart loop.
 *   - `[update]`: clear ONLY on installer success. Retain on failure
 *     so the next tick retries (installs are flaky).
 */
export async function reconcileSelf(deps: ReconcileSelfDeps): Promise<void> {
  const expected = deps.currentState();
  const observed = readDaemonState(deps.daemonService.statePath);
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
  // Always re-write to refresh mtime; siblings consult mtime via
  // DAEMON_STALE_GRACE_PERIOD_MS to decide whether the file is fresh.
  writeDaemonState(deps.daemonService.statePath, expected);

  const intent = readIntent(deps.daemonService);
  if (intent.restart) {
    deps.logger.info(
      LOG_KINDS.DAEMON_RECONCILE,
      'Restart intent observed; initiating supervisor restart',
      { requested_at: intent.restart.requested_at, reason: intent.restart.reason ?? null },
    );
    clearIntentSection(deps.daemonService, 'restart');
    deps.requestSupervisorRestart?.();
  }

  if (intent.update) {
    const current = deps.currentState().version;
    if (intent.update.target_version === current) {
      deps.logger.info(
        LOG_KINDS.DAEMON_RECONCILE,
        'Update intent target matches current version; clearing',
        { target_version: intent.update.target_version, current_version: current ?? null },
      );
      clearIntentSection(deps.daemonService, 'update');
    } else if (deps.installUpdate) {
      deps.logger.info(LOG_KINDS.DAEMON_RECONCILE, 'Update intent observed', {
        target_version: intent.update.target_version,
        current_version: current ?? null,
      });
      try {
        await deps.installUpdate(intent.update.target_version);
        clearIntentSection(deps.daemonService, 'update');
      } catch (err) {
        deps.logger.error(
          LOG_KINDS.DAEMON_RECONCILE,
          'Update failed; intent retained for retry',
          { target_version: intent.update.target_version, err: String(err) },
        );
      }
    }
  }
}
