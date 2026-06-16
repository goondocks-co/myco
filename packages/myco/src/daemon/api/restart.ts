import { spawn } from 'node:child_process';
import { z } from 'zod';
import { resolveProjectRoot } from '../../vault/resolve.js';
import { resolveCliEntryPath } from '../../hooks/client.js';
import type { RouteResponse } from '../router.js';
import type { ProgressTracker } from './progress.js';
import { RESTART_RESPONSE_FLUSH_MS } from '../../constants.js';
import { getServiceManager } from '../../service/manager.js';
import { serviceLabel } from '../../service/labels.js';
import type { ServiceManager, ServiceStatus, ServiceVariant } from '../../service/types.js';

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
}

/**
 * Build the argv for the detached restart child, spawned against the binary
 * directly on EVERY platform (no shell, no quoting, no POSIX `sleep`).
 *
 * - Service-managed → `[…cliEntry] service restart [--dev]`, which routes
 *   through the platform manager (launchctl kickstart -k / systemctl --user
 *   restart / schtasks /end + /run). That primitive SIGTERMs us atomically and
 *   the supervisor respawns us — no thundering-herd race with KeepAlive.
 * - Not service-managed → `[…cliEntry] daemon`; the respawned daemon waits on
 *   the lifecycle-lock release for the exiting one, so no startup delay needed.
 */
export function buildRestartArgv(
  serviceManagedLabel: string | null,
  cliEntry: string | null,
): string[] {
  const base = cliEntry !== null ? [cliEntry] : [];
  if (serviceManagedLabel) {
    const dev = serviceManagedLabel.endsWith('-dev') ? ['--dev'] : [];
    return [...base, 'service', 'restart', ...dev];
  }
  return [...base, 'daemon'];
}

/** Find the first installed service across variants and return its label and
 *  current status. Process-agnostic — used by client-side surfaces
 *  (DaemonClient.spawnDaemon) that only need to know "is there a service
 *  supervisor that owns the daemon for our variant" without checking PID. */
const SERVICE_VARIANTS: ServiceVariant[] = ['dev', 'prod'];

export async function findInstalledServiceLabel(
  mgr: ServiceManager,
  variant?: ServiceVariant,
): Promise<{ label: string; status: ServiceStatus } | null> {
  if (!mgr.supported) return null;
  for (const candidate of variant ? [variant] : SERVICE_VARIANTS) {
    const label = serviceLabel(candidate);
    const installed = await mgr.isInstalled(label).catch(() => false);
    if (!installed) continue;
    const status = await mgr.status(label).catch(() => null);
    if (status) return { label, status };
    return {
      label,
      status: { installed: true, running: false, pid: null, lastExitCode: null, unitPath: null },
    };
  }
  return null;
}

/** Probe whether THIS process is the currently-running service-managed daemon.
 *  Returns the label if so, otherwise null.
 *
 *  Exported so other detached-script paths (update-installer post-install
 *  respawn, sibling-version-sync restart) can share a single detection
 *  implementation. Pass `process.pid` from the caller; defaults to it. */
export async function detectServiceManagedLabel(
  mgr: ServiceManager,
  myPid: number = process.pid,
): Promise<string | null> {
  // Platform-agnostic: the manager owns the "is this me?" decision
  // (`isManagedDaemon`) — POSIX pid-matches, Windows reads its env marker.
  for (const variant of SERVICE_VARIANTS) {
    const found = await findInstalledServiceLabel(mgr, variant);
    if (found && mgr.isManagedDaemon(found.label, found.status, myPid)) return found.label;
  }
  return null;
}

/**
 * Resolve the literal supervisor restart command to bake into a detached
 * update/restart script. Returns the platform-specific kickstart/systemctl
 * string when this process is the service-managed daemon, otherwise
 * undefined — meaning the detached script should respawn a daemon child
 * directly. Single source of truth for the /api/update/* and SELF_RECONCILE
 * install paths so they agree on the supervisor.
 */
export async function resolveServiceRestartCommand(
  mgr: ServiceManager,
): Promise<string | undefined> {
  const label = await detectServiceManagedLabel(mgr);
  if (!label) return undefined;
  try {
    return mgr.restartShellCommand(label);
  } catch {
    return undefined;
  }
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
  const serviceManagedLabel = await detectServiceManagedLabel(mgr);

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
    process.kill(process.pid, 'SIGTERM');
  }, sigtermDelay);

  return {
    body: { status: 'restarting' },
  };
}
