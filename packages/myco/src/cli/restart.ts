import { resolveDaemonServiceState } from '../daemon/service-state.js';
import { mergeIntent } from '../daemon/intent.js';
import { DaemonClient } from '../hooks/client.js';
import { serviceLabel, serviceVariantForState } from '../service/labels.js';

const RESTART_CONVERGE_DEADLINE_MS = 15_000;
const RESTART_POLL_INTERVAL_MS = 500;

export async function run(_args: string[], vaultDir: string): Promise<void> {
  const daemonService = resolveDaemonServiceState(vaultDir);
  const client = new DaemonClient(vaultDir);
  const before = await client.getInfoAsync();

  if (!before) {
    const label = serviceLabel(serviceVariantForState(daemonService));
    const supervisorHint = process.platform === 'darwin'
      ? `  launchctl list | grep ${label}`
      : `  systemctl --user status ${label}.service`;
    console.error('No daemon found on the canonical port and no state file present.');
    console.error('If the daemon should be running, check the supervisor:');
    console.error(supervisorHint);
    process.exit(1);
  }

  mergeIntent(daemonService, {
    restart: { requested_at: new Date().toISOString(), reason: 'cli' },
  });
  console.log(`Restart requested for daemon ${before.pid} on port ${before.port}.`);
  console.log('Waiting for the reconciler to converge...');

  // A null poll result during the SIGTERM→respawn gap is expected;
  // keep polling until a new pid surfaces or the deadline elapses.
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
