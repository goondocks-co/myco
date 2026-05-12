import { spawn } from 'node:child_process';
import { z } from 'zod';
import { resolveProjectRoot } from '../../vault/resolve.js';
import { resolveCliEntryPath } from '../../hooks/client.js';
import type { RouteResponse } from '../router.js';
import type { ProgressTracker } from './progress.js';
import { RESTART_RESPONSE_FLUSH_MS } from '../../constants.js';
import { getServiceManager } from '../../service/manager.js';
import { serviceLabel } from '../../service/labels.js';
import type { ServiceManager, ServiceVariant } from '../../service/types.js';

const RestartBodySchema = z.object({
  force: z.boolean().optional(),
}).optional();
/** Delay before the child process starts — allows the parent to fully release the port. */
const RESTART_CHILD_DELAY_SECONDS = 3;
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
 * Build the shell command the detached child will run.
 *
 * - When service-managed, the child invokes `myco service restart [--dev]`
 *   which routes through the platform service manager (launchctl kickstart -k
 *   / systemctl --user restart). That primitive SIGTERMs us atomically and the
 *   service supervisor respawns us — preventing the thundering-herd race
 *   between a manually-spawned daemon and the supervisor's KeepAlive.
 * - When not service-managed, the child spawns a fresh `myco daemon` directly,
 *   as before.
 */
export function buildRestartShellCommand(
  serviceManagedLabel: string | null,
  execPath: string,
  cliEntry: string | null,
): string {
  const entryPart = cliEntry !== null ? ` ${cliEntry}` : '';
  if (serviceManagedLabel) {
    const variantFlag = serviceManagedLabel.endsWith('-dev') ? ' --dev' : '';
    // Short sleep so the HTTP response flushes before the service-restart fires.
    return `sleep 0.5 && ${execPath}${entryPart} service restart${variantFlag}`;
  }
  return `sleep ${RESTART_CHILD_DELAY_SECONDS} && ${execPath}${entryPart} daemon`;
}

/** Probe whether THIS process is the currently-running service-managed daemon.
 *  Returns the label if so, otherwise null. */
async function detectServiceManagedLabel(mgr: ServiceManager): Promise<string | null> {
  if (!mgr.supported) return null;
  for (const variant of ['dev', 'prod'] as ServiceVariant[]) {
    const label = serviceLabel(variant);
    const installed = await mgr.isInstalled(label).catch(() => false);
    if (!installed) continue;
    const st = await mgr.status(label).catch(() => null);
    if (st?.running && st.pid === process.pid) return label;
  }
  return null;
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
  const shellCmd = buildRestartShellCommand(serviceManagedLabel, execPath, cliEntry);

  const projectRoot = resolveProjectRoot(deps.vaultDir);
  const child = spawn('/bin/sh', ['-c', shellCmd], {
    detached: true,
    stdio: 'ignore',
    cwd: projectRoot,
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
    body: {
      status: 'restarting',
      serviceManaged: serviceManagedLabel !== null,
      ...(serviceManagedLabel ? { serviceLabel: serviceManagedLabel } : {}),
    },
  };
}
