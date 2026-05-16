import type { DaemonLogger } from './logger.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import {
  readDaemonState,
  writeDaemonState,
  type DaemonServiceState,
  type DaemonState,
} from './service-state.js';

export interface ReconcileSelfDeps {
  daemonService: DaemonServiceState;
  currentState: () => DaemonState;
  logger: DaemonLogger;
}

/**
 * Continuously-enforced invariant: if THIS process is alive and serving
 * on its variant's canonical port, daemon.json for that variant must
 * exist and accurately describe this process. Called from the
 * PowerManager reconcile tick (every active/idle/sleep tick) so the
 * `pid alive ⇔ daemon.json exists` invariant is no longer just a
 * startup guarantee — anything that nukes the file externally is
 * re-asserted within one tick.
 *
 * Idempotent: when the file already matches expected state, the
 * re-write only refreshes mtime, which keeps the freshness window
 * `reconcileExistingDaemon` consults for siblings accurate.
 */
export function reconcileSelf(deps: ReconcileSelfDeps): void {
  const expected = deps.currentState();
  const observed = readDaemonState(deps.daemonService.statePath);
  if (observed && observed.pid === expected.pid && observed.port === expected.port) {
    // File is correct in shape; refresh atime/mtime via re-write so the
    // freshness window stays open for sibling reconciliation paths
    // that read mtime to decide whether the file is fresh enough to
    // trust.
    writeDaemonState(deps.daemonService.statePath, expected);
    return;
  }
  // File missing or pointing elsewhere. The live process IS the source
  // of truth; the file is its projection. Re-write authoritatively and
  // log the discrepancy so externally-induced drift is visible.
  deps.logger.info(LOG_KINDS.DAEMON_RECONCILE, 'Re-asserting daemon.json from live state', {
    had_file: observed !== null,
    state_path: deps.daemonService.statePath,
    expected_pid: expected.pid,
    observed_pid: observed?.pid ?? null,
    expected_port: expected.port,
    observed_port: observed?.port ?? null,
  });
  writeDaemonState(deps.daemonService.statePath, expected);
}
