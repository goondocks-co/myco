import { resolveDaemonServiceState } from '../daemon/service-state.js';
import { writeRestartIntent } from '../daemon/intent.js';
import { DaemonClient } from '../hooks/client.js';
import { serviceLabel, serviceVariantForState } from '../service/labels.js';

const RESTART_CONVERGE_DEADLINE_MS = 15_000;
const RESTART_POLL_INTERVAL_MS = 500;

/**
 * `myco restart` mirrors the UI's Restart button: POST /api/restart, which
 * synchronously spawns the supervisor kickstart (launchctl/systemctl) and
 * SIGTERMs the daemon. The HTTP request itself wakes a deep_sleep daemon —
 * no dependency on the SELF_RECONCILE PowerManager tick, which is registered
 * `runIn: ['active', 'idle', 'sleep']` and skips deep_sleep by design
 * (see self-reconcile-wiring.ts).
 *
 * The intent file is written as a fallback only — when /api/restart is
 * unreachable (daemon HTTP server broken but process alive). In that case
 * the file gets picked up if/when the reconciler tick next fires; otherwise
 * the user is steered toward `myco daemon kill` for a supervisor-driven
 * respawn.
 */
export async function run(args: string[], vaultDir: string): Promise<void> {
  const force = args.includes('--force');
  const daemonService = resolveDaemonServiceState(vaultDir);
  const client = new DaemonClient(vaultDir);
  const before = await client.getInfoAsync();

  if (!before) {
    const label = serviceLabel(serviceVariantForState(daemonService));
    const supervisorHint = supervisorStatusHint(label);
    console.error('No daemon found on the canonical port and no state file present.');
    console.error('If the daemon should be running, check the supervisor:');
    console.error(supervisorHint);
    process.exit(1);
  }

  const result = await client.post('/api/restart', force ? { force: true } : {});

  if (!result.ok) {
    const errMsg = extractErrorMessage(result.data);
    if (errMsg === 'busy') {
      console.error('Restart rejected: active operations in progress.');
      console.error('  Rerun with --force to restart anyway.');
      process.exit(1);
    }
    // HTTP-unreachable fallback: write the intent file so the reconciler
    // tick picks it up if/when it next fires. Will NOT converge from
    // deep_sleep — the SELF_RECONCILE job is excluded from that state —
    // hence the documented escape hatch.
    writeRestartIntent(daemonService, {
      requested_at: new Date().toISOString(),
      reason: 'cli',
    });
    console.error('Restart endpoint unreachable; intent file written as fallback.');
    console.error('  If the daemon does not respawn shortly, run `myco daemon kill`');
    console.error('  and let the supervisor (launchd/systemd) respawn it.');
    process.exit(1);
  }

  console.log(`Restart requested for daemon ${before.pid} on port ${before.port}.`);
  console.log('Waiting for the daemon to respawn...');

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
    `Daemon did not respawn within ${RESTART_CONVERGE_DEADLINE_MS / 1000}s.`,
  );
  console.error('  The /api/restart call succeeded, so the supervisor was invoked;');
  console.error('  if the daemon still has not respawned, check supervisor logs.');
  process.exit(1);
}

/**
 * The down-daemon recovery hint: the supervisor command the user can run to
 * inspect (or kick) the service on their platform. launchd/systemd surface a
 * status query; Windows mirrors the Task Scheduler `/run` primitive that the
 * service manager uses (see windows.ts `restartShellCommand`), since `schtasks
 * /query` output is far noisier and the task name IS the service label.
 */
export function supervisorStatusHint(
  label: string,
  platform: NodeJS.Platform = process.platform,
): string {
  switch (platform) {
    case 'darwin':
      return `  launchctl list | grep ${label}`;
    case 'win32':
      return `  schtasks /run /tn "${label}"   (or check the Task Scheduler service)`;
    default:
      return `  systemctl --user status ${label}.service`;
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.status === 'string') return obj.status;
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.error === 'string') return obj.error;
  return null;
}
