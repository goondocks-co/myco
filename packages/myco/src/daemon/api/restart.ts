import { spawn } from 'node:child_process';
import { z } from 'zod';
import { resolveProjectRoot } from '../../vault/resolve.js';
import { resolveCliEntryPath } from '../../hooks/client.js';
import type { RouteResponse } from '../router.js';
import type { ProgressTracker } from './progress.js';
import { RESTART_RESPONSE_FLUSH_MS } from '../../constants.js';
import { getServiceManager } from '../../service/manager.js';
import { serviceLabel } from '../../service/labels.js';
import { resolveMycoHome } from '../../grove/paths.js';
import type { ServiceManager, ServiceStatus } from '../../service/types.js';
import { terminateDaemonProcess } from '../../service/daemon-termination.js';

const RestartBodySchema = z.object({
  force: z.boolean().optional(),
}).optional();
/** When service-managed, fall back to self-SIGTERM after this many ms in case
 *  the service-restart child fails silently. Longer than the non-service path
 *  so the kickstart-driven SIGTERM has a chance to land first. */
const SERVICE_RESTART_FALLBACK_SIGTERM_MS = 5000;

export interface RestartHandlerDeps {
  vaultDir: string;
  progressTracker: ProgressTracker;
  /** Optional override for tests; defaults to the platform service manager. */
  serviceManager?: ServiceManager;
  /** Schedules this daemon's termination. */
  terminateSelf?: () => Promise<void>;
}

/**
 * Build the argv for the detached restart child, spawned against the binary
 * directly on EVERY platform (no shell, no quoting, no POSIX `sleep`).
 *
 * - Service-managed → `[…cliEntry] service restart`, which routes through the
 *   platform manager (launchctl kickstart -k / systemctl --user restart /
 *   schtasks /end + /run). That primitive SIGTERMs us atomically and the
 *   supervisor respawns us — no thundering-herd race with KeepAlive. The child
 *   inherits MYCO_HOME, so `service restart` targets this daemon's home.
 * - Not service-managed → `[…cliEntry] daemon`; the respawned daemon waits on
 *   the lifecycle-lock release for the exiting one, so no startup delay needed.
 */
export function buildRestartArgv(
  serviceManagedLabel: string | null,
  cliEntry: string | null,
): string[] {
  const base = cliEntry !== null ? [cliEntry] : [];
  if (serviceManagedLabel) {
    return [...base, 'service', 'restart'];
  }
  return [...base, 'daemon'];
}

/** Find the installed service for a home and return its label and current
 *  status. There is exactly one managed service per home (its identity IS the
 *  home), so this checks the single `serviceLabel(mycoHome)`. Process-agnostic —
 *  used by client-side surfaces (DaemonClient.spawnDaemon) that only need to
 *  know "is there a service supervisor that owns this home's daemon" without
 *  checking PID. */
export async function findInstalledServiceLabel(
  mgr: ServiceManager,
  mycoHome: string = resolveMycoHome(),
): Promise<{ label: string; status: ServiceStatus } | null> {
  if (!mgr.supported) return null;
  const label = serviceLabel(mycoHome);
  const installed = await mgr.isInstalled(label).catch(() => false);
  if (!installed) return null;
  const status = await mgr.status(label).catch(() => null);
  if (status) return { label, status };
  return {
    label,
    status: { installed: true, running: false, pid: null, lastExitCode: null, unitPath: null },
  };
}

/**
 * Resolve the service label to ROUTE A RESTART THROUGH for a home, or null when
 * no supervisor owns this home's daemon (the caller then respawns directly).
 *
 * Restart routing keys on supervisor INSTALLATION (the plist/unit exists for
 * `mycoHome`), NOT on pid-identity. A daemon that has DETACHED from its launchd
 * job — live pid ≠ the supervisor-tracked pid, e.g. after a prior direct-spawn
 * restart — must still restart via the supervisor's native primitive
 * (`launchctl kickstart -k` / `systemctl --user restart`) so the supervisor
 * RE-ADOPTS it. Pid-identity matching returns null in exactly that detached
 * state, stranding the daemon on a detached direct-spawn that re-detaches on
 * every restart; keying on the installed unit heals it. It is also the only
 * correct answer off the daemon process — the CLI never shares the daemon's
 * pid — so `myco upgrade` from the CLI routes through the supervisor too.
 *
 * Exported so every restart path (this handler, version-sync, upgrade/adopt)
 * shares one resolver and the routing rule lives in exactly one place.
 */
export async function resolveRestartServiceLabel(
  mgr: ServiceManager,
  mycoHome: string = resolveMycoHome(),
): Promise<string | null> {
  const found = await findInstalledServiceLabel(mgr, mycoHome);
  return found?.label ?? null;
}

export async function handleRestart(
  deps: RestartHandlerDeps,
  body: unknown,
): Promise<RouteResponse> {
  const parsed = RestartBodySchema.safeParse(body);
  const force = parsed.success ? parsed.data?.force : false;

  // Check for active operations unless force is set
  if (!force && deps.progressTracker.hasActiveOperations()) {
    return {
      status: 409,
      body: { status: 'busy', message: 'Active operations in progress. Use force=true to override.' },
    };
  }

  const mgr = deps.serviceManager ?? getServiceManager();
  const serviceManagedLabel = await resolveRestartServiceLabel(mgr);

  // Schedule: respond → wait for flush → SIGTERM self → child starts after parent exits.
  // When service-managed, the child calls `myco service restart`, which uses
  // launchctl kickstart -k / systemctl --user restart to atomically SIGTERM us
  // and respawn through the supervisor — no race with KeepAlive.
  const { execPath, cliEntry } = resolveCliEntryPath();
  const projectRoot = resolveProjectRoot(deps.vaultDir);

  // Spawn the binary DIRECTLY (argv, no shell) on every platform — one code
  // path, no `/bin/sh` (absent on Windows), no cmd.exe quoting, no POSIX
  // `sleep`. Timing is handled downstream: a respawned `daemon` waits on the
  // lifecycle-lock release, and `service restart` is atomic via the platform
  // supervisor. (The prior `/bin/sh -c` ENOENT'd on Windows, so the restart
  // child never ran and the daemon went down for good.) `windowsHide` is inert
  // on POSIX.
  const child = spawn(execPath, buildRestartArgv(serviceManagedLabel, cliEntry), {
    detached: true,
    stdio: 'ignore',
    cwd: projectRoot,
    windowsHide: true,
  });
  // No listener = a spawn-class 'error' is an uncaught exception (process
  // exit) — precisely during a restart request, when dying without the
  // child running means no daemon comes back.
  child.on('error', (err) => {
    try {
      process.stderr.write(`[myco] restart child spawn failed: ${err.message}\n`);
    } catch { /* best-effort */ }
  });
  child.unref();

  // Self-termination scheduling:
  //  - Non-service: SIGTERM self promptly so the child can claim the port.
  //  - Service-managed: the supervisor's kickstart will SIGTERM us. Keep a
  //    longer fallback timer so we still die if the service-restart child fails.
  const sigtermDelay = serviceManagedLabel
    ? SERVICE_RESTART_FALLBACK_SIGTERM_MS
    : RESTART_RESPONSE_FLUSH_MS;
  setTimeout(() => {
    void (deps.terminateSelf
      ? deps.terminateSelf()
      : terminateDaemonProcess(process.pid, 'SIGTERM'))
      .catch((error) => {
        try {
          process.stderr.write(
            `[myco] restart termination blocked: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        } catch { /* best-effort */ }
      });
  }, sigtermDelay);

  return {
    body: { status: 'restarting' },
  };
}
