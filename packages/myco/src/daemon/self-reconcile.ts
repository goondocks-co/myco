import type { DaemonLogger } from './logger.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import {
  readDaemonState,
  writeOrTouchDaemonState,
  type DaemonServiceState,
  type DaemonState,
} from './service-state.js';
import { readIntent, clearIntentSection } from './intent.js';
import { installGlobalLaunchers } from '../grove/launcher-install.js';

export interface ReconcileSelfDeps {
  daemonService: DaemonServiceState;
  currentState: () => DaemonState;
  logger: DaemonLogger;
  requestSupervisorRestart?: () => void;
  installUpdate?: (targetVersion: string) => Promise<void>;
  /**
   * Override the launcher-install step for tests; production callers
   * use the bundled-template-driven default.
   */
  refreshLaunchers?: () => void;
  /**
   * Reads the post-install error file (~/.myco/update-error.json) if
   * present. The installer script writes this on npm install failure
   * and clears it on success, so its presence on a daemon that has the
   * old version means the most recent attempt failed.
   */
  readUpdateError?: () => string | null;
  /** Removes the update-error.json file so a future install starts clean. */
  consumeUpdateError?: () => void;
  /**
   * True when an `update.in-progress` sentinel is present and fresh —
   * another orchestrator (likely `/api/update/apply`) has already
   * spawned an installer that the reconciler must not duplicate.
   * Gates the intent.update branch BEFORE any logging or installUpdate
   * call: a tick that observes an in-flight update is a no-op.
   */
  updateInFlight?: () => boolean;
}

/**
 * Continuously enforces `pid alive ⇔ daemon.json exists` and drains
 * per-section intent files. Two intent kinds with deliberately asymmetric
 * clear semantics:
 *
 *   [restart] (intent.restart.toml)
 *     - Clear BEFORE invoking the supervisor restart — load-bearing. A
 *       respawn that observes the intent before it is cleared would
 *       trigger an infinite restart loop.
 *
 *   [update] (intent.update.toml)
 *     - Retain across the install spawn so the post-restart daemon can
 *       finish the decision: success (version matches target) clears it,
 *       failure (update-error.json present) clears it and surfaces.
 *     - On the FIRST tick that observes the intent: check update-error
 *       to detect a prior-attempt failure. If present, log + clear (no
 *       auto-retry — surface to the user). Otherwise spawn the installer
 *       and let the daemon shut down; intent persists across the restart.
 *     - Sync spawn failures (the rare path where installUpdate throws
 *       before the script lands) leave the intent in place so the next
 *       tick retries.
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
  writeOrTouchDaemonState(deps.daemonService.statePath, expected);

  const intent = readIntent(deps.daemonService);

  if (intent.refresh_launchers) {
    // Refresh `~/.myco/launcher.cjs` + `~/.myco/mcp-launcher.cjs` from
    // the bundled template. Always runs on the daemon thread (never on
    // the hook process) so we don't race a hook script that is currently
    // exec'ing the file. Clear AFTER the write so an in-flight crash
    // leaves the intent for the next tick to retry — the write itself
    // is atomic + idempotent.
    deps.logger.info(
      LOG_KINDS.DAEMON_RECONCILE,
      'Refresh-launchers intent observed; rewriting global launcher files',
      {
        requested_at: intent.refresh_launchers.requested_at,
        reason: intent.refresh_launchers.reason ?? null,
      },
    );
    try {
      const refresh = deps.refreshLaunchers ?? (() => installGlobalLaunchers());
      refresh();
      clearIntentSection(deps.daemonService, 'refresh_launchers');
    } catch (err) {
      deps.logger.error(
        LOG_KINDS.DAEMON_RECONCILE,
        'Launcher refresh failed; intent retained for next-tick retry',
        { err: String(err) },
      );
    }
  }

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
    if (deps.updateInFlight?.() === true) {
      // Another orchestrator already has an installer in flight for
      // this update intent. Stay silent — the post-restart reconciler
      // tick will decide whether the install succeeded (version
      // matches) or failed (update-error.json present).
      return;
    }
    const current = deps.currentState().version;
    if (intent.update.target_version === current) {
      deps.logger.info(
        LOG_KINDS.DAEMON_RECONCILE,
        'Update intent target matches current version; clearing',
        { target_version: intent.update.target_version, current_version: current ?? null },
      );
      clearIntentSection(deps.daemonService, 'update');
    } else if (deps.installUpdate) {
      const priorError = deps.readUpdateError?.() ?? null;
      if (priorError) {
        deps.logger.error(
          LOG_KINDS.DAEMON_RECONCILE,
          'Update failed during a prior attempt; clearing intent (no auto-retry — see ~/.myco/update-error.json)',
          {
            target_version: intent.update.target_version,
            current_version: current ?? null,
            error: priorError,
          },
        );
        clearIntentSection(deps.daemonService, 'update');
        deps.consumeUpdateError?.();
      } else {
        deps.logger.info(LOG_KINDS.DAEMON_RECONCILE, 'Update intent observed', {
          target_version: intent.update.target_version,
          current_version: current ?? null,
        });
        try {
          await deps.installUpdate(intent.update.target_version);
          // Intent intentionally NOT cleared here. The installer script
          // is detached: it will restart the daemon (success or failure).
          // The next-tick reconciler on the post-restart daemon decides
          // based on current.version vs intent.update.target_version
          // and the presence of update-error.json.
        } catch (err) {
          deps.logger.error(
            LOG_KINDS.DAEMON_RECONCILE,
            'Update spawn failed synchronously; intent retained for next-tick retry',
            { target_version: intent.update.target_version, err: String(err) },
          );
        }
      }
    }
  }
}
