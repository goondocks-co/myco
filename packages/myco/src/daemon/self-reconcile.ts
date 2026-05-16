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
  /**
   * Invoked when a restart intent is observed and after the intent
   * section has been cleared. Optional so unit tests can omit it (or
   * pass a spy). In production this fans out to `launchctl kickstart`
   * or `systemctl --user restart` via `power-jobs.ts`.
   */
  requestSupervisorRestart?: () => void;
  /**
   * Invoked when an update intent is observed for a version OTHER than
   * the currently running daemon's version. Optional so unit tests can
   * omit it. In production this delegates to `spawnUpdateScript` via
   * `power-jobs.ts`.
   *
   * Pattern asymmetry vs `requestSupervisorRestart`: this runs BEFORE
   * the intent section is cleared. On success the section is cleared
   * (we're done). On failure the section is RETAINED so the next
   * reconcile tick retries — installs are flaky (network, npm) and
   * should be auto-resilient. The user-facing failure surface is
   * `update-error.json`, written by the existing installer.
   */
  installUpdate?: (targetVersion: string) => Promise<void>;
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
 *
 * Also consumes the intent file (`intent.toml`):
 *   - `[restart]`: clear BEFORE invoking the supervisor restart, then
 *     fan out via `requestSupervisorRestart`. The clear-before-act
 *     ordering is load-bearing — a respawn with the intent still
 *     present would trigger an infinite restart loop.
 *   - `[update]`: invoke `installUpdate` THEN clear on success.
 *     Retain on failure so the next tick can retry. If the target
 *     version already matches the running daemon, clear without
 *     invoking the installer.
 */
export async function reconcileSelf(deps: ReconcileSelfDeps): Promise<void> {
  const expected = deps.currentState();
  const observed = readDaemonState(deps.daemonService.statePath);
  if (observed && observed.pid === expected.pid && observed.port === expected.port) {
    // File is correct in shape; refresh atime/mtime via re-write so the
    // freshness window stays open for sibling reconciliation paths
    // that read mtime to decide whether the file is fresh enough to
    // trust.
    writeDaemonState(deps.daemonService.statePath, expected);
  } else {
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

  // Intent consumption. Read whatever sections are present and act on
  // each. The file is small and read-once per tick; no caching needed.
  const intent = readIntent(deps.daemonService);
  if (intent.restart) {
    deps.logger.info(
      LOG_KINDS.DAEMON_RECONCILE,
      'Restart intent observed; initiating supervisor restart',
      {
        requested_at: intent.restart.requested_at,
        reason: intent.restart.reason ?? null,
      },
    );
    // Clear the section BEFORE triggering restart so a respawn loop
    // doesn't reapply the same intent. The supervisor SIGTERMs us
    // synchronously-ish; if we cleared after triggering, a fast
    // respawn could read the same intent again.
    clearIntentSection(deps.daemonService, 'restart');
    deps.requestSupervisorRestart?.();
  }

  if (intent.update) {
    const current = deps.currentState().version;
    if (intent.update.target_version === current) {
      // Already at the requested version — the daemon was likely
      // restarted into the target binary but the intent file wasn't
      // cleared. Clean up so we don't re-evaluate forever.
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
        // Clear AFTER success — installs can fail (network, npm); the
        // retained intent lets the next tick retry without re-issuing
        // the CLI command.
        clearIntentSection(deps.daemonService, 'update');
      } catch (err) {
        deps.logger.error(
          LOG_KINDS.DAEMON_RECONCILE,
          'Update failed; intent retained for retry',
          {
            target_version: intent.update.target_version,
            err: String(err),
          },
        );
      }
    }
  }
}
