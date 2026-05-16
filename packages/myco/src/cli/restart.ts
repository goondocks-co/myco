import { resolveDaemonServiceState } from '../daemon/service-state.js';
import { mergeIntent } from '../daemon/intent.js';
import { DaemonClient } from '../hooks/client.js';

/** How long the CLI waits for the supervisor-driven respawn before giving up. */
const RESTART_CONVERGE_DEADLINE_MS = 15_000;
/** Poll interval while waiting for a new pid to appear on the canonical port. */
const RESTART_POLL_INTERVAL_MS = 500;

/**
 * `myco restart` is the first command migrated to the intent +
 * reconciliation model. The CLI no longer shuts down or kills the
 * daemon itself. Instead:
 *
 *   1. Write `[restart]` into intent.toml (atomic).
 *   2. Exit.
 *   3. The daemon's continuous `reconcileSelf` PowerManager tick
 *      observes the intent on its next iteration, clears the section
 *      (so a respawn loop doesn't reapply it), and triggers a
 *      supervisor-side restart (`launchctl kickstart -k` on macOS,
 *      `systemctl --user restart` on Linux).
 *   4. The supervisor SIGTERMs the daemon and respawns it. A fresh
 *      daemon.json appears on startup.
 *
 * The CLI polls `getInfoAsync()` — which falls back to `/health` on
 * the canonical port when daemon.json is missing — and waits for a
 * new pid to surface. During the gap between SIGTERM and respawn,
 * `getInfoAsync()` returns null; the loop treats that as "still
 * restarting", not failure.
 */
export async function run(_args: string[], vaultDir: string): Promise<void> {
  const daemonService = resolveDaemonServiceState(vaultDir);
  const client = new DaemonClient(vaultDir);
  const before = await client.getInfoAsync();

  if (!before) {
    console.error('No daemon found on the canonical port and no state file present.');
    const supervisorHint = process.platform === 'darwin'
      ? `  launchctl list | grep ${daemonService.scope === 'global' ? 'co.goondocks.myco' : 'co.goondocks.myco-dev'}`
      : `  systemctl --user status myco.service`;
    console.error('If the daemon should be running, check the supervisor:');
    console.error(supervisorHint);
    process.exit(1);
  }

  mergeIntent(daemonService, {
    restart: { requested_at: new Date().toISOString(), reason: 'cli' },
  });
  console.log(`Restart requested for daemon ${before.pid} on port ${before.port}.`);
  console.log('Waiting for the reconciler to converge...');

  // The reconciler ticks at PowerManager cadence; the supervisor
  // SIGTERMs and respawns. A new pid on the canonical port (or on
  // daemon.json after the fresh daemon's startup write) signals
  // convergence. A null result during the gap is expected — keep
  // polling until the deadline.
  const deadline = Date.now() + RESTART_CONVERGE_DEADLINE_MS;
  const previousPid = before.pid;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RESTART_POLL_INTERVAL_MS));
    const now = await client.getInfoAsync();
    if (now && now.pid !== previousPid) {
      console.log(`Stopped daemon ${previousPid}`);
      console.log(`Daemon healthy on port ${now.port} (pid ${now.pid})`);
      console.log(`Dashboard: http://localhost:${now.port}/`);
      return;
    }
  }
  console.error(
    `Reconciler did not converge within ${RESTART_CONVERGE_DEADLINE_MS / 1000}s. `
    + 'The intent file remains; the daemon will pick it up on the next tick.',
  );
  process.exit(1);
}
