/**
 * Wire the host-serve enablement into the running daemon (Task 2.1 → Task 2.3).
 *
 * Two steps, both idempotent:
 *   1. WRITE `daemon.host_serve = { enabled, overlay_address }` to the MACHINE
 *      tier via the machine-tier one-write-path (`saveMachineConfig`). Task 2.3
 *      reads exactly this at daemon startup and binds a second overlay listener.
 *      The overlay address MUST be a 100.64/10 CGNAT IP or Task 2.3's
 *      `isOverlayRangeAddress` gate refuses to serve — we assert that HERE, at the
 *      write boundary, so an out-of-range address never reaches config.
 *   2. APPLY it by restarting the daemon. Host-serve is read once at startup
 *      (`daemon/main.ts`), so a config write alone is inert — the daemon must
 *      restart to bind (or unbind) the overlay listener. `myco-team` is a separate
 *      process, so restarting via the platform ServiceManager is the safe path
 *      (no self-SIGTERM). When the daemon is not service-managed we surface a
 *      manual-restart instruction rather than failing.
 *
 * The write is machine-tier and machine-global; there is no project vault context
 * in `host enable`, so `saveMachineConfig` (not the project-scoped `updateConfig`)
 * is the correct one-write-path — it validates via `MachineConfigSchema`, writes
 * atomically to `~/.myco/config.yaml`, and invalidates the tier cache.
 */
import { loadMachineConfig, saveMachineConfig } from '@myco/config/loader.js';
import { isOverlayRangeAddress } from '@myco/daemon/host-serve.js';
import { resolveMycoHome } from '@myco/grove/paths.js';
import { getServiceManager } from '@myco/service/manager.js';
import { serviceLabel } from '@myco/service/labels.js';
import type { ServiceManager } from '@myco/service/types.js';

export interface HostServeApply {
  enabled: boolean;
  /** The host's 100.64/10 overlay IP when enabling; null clears it (disable). */
  overlayAddress: string | null;
}

/**
 * Persist the host-serve enablement to the machine tier. Refuses to write an
 * enabled config whose address is not a 100.64/10 overlay IP (the same gate
 * Task 2.3 enforces downstream), so a bad address fails loud at enable time
 * rather than silently leaving host-serve off after a restart.
 */
export function writeHostServeConfig(apply: HostServeApply, mycoHome: string = resolveMycoHome()): void {
  if (apply.enabled && !isOverlayRangeAddress(apply.overlayAddress)) {
    throw new Error(
      `Refusing to enable host-serve: overlay_address ${JSON.stringify(apply.overlayAddress)} is not a `
      + '100.64.0.0/10 (CGNAT) overlay IP. The daemon overlay listener would refuse to bind it.',
    );
  }
  const machine = loadMachineConfig(mycoHome);
  saveMachineConfig(
    {
      ...machine,
      daemon: {
        ...machine.daemon,
        host_serve: { enabled: apply.enabled, overlay_address: apply.enabled ? apply.overlayAddress : null },
      },
    },
    mycoHome,
  );
}

export interface DaemonRestartResult {
  restarted: boolean;
  detail: string;
}

/**
 * Restart the daemon so it re-reads host-serve and (un)binds the overlay listener.
 * Uses the platform ServiceManager (a separate-process restart — safe, no
 * self-SIGTERM). When the daemon is not installed as a service, returns
 * `restarted:false` with an operator instruction instead of throwing.
 */
export async function restartDaemonForHostServe(
  mycoHome: string = resolveMycoHome(),
  manager: ServiceManager = getServiceManager(),
): Promise<DaemonRestartResult> {
  const label = serviceLabel(mycoHome);
  if (!manager.supported) {
    return { restarted: false, detail: `Restart the Myco daemon manually to apply host-serve (${manager.platformName}).` };
  }
  if (!(await manager.isInstalled(label))) {
    return {
      restarted: false,
      detail: 'The Myco daemon is not installed as a managed service; restart it manually (`myco restart`) to apply host-serve.',
    };
  }
  await manager.restart(label);
  return { restarted: true, detail: `Restarted the Myco daemon service (${label}) to apply host-serve.` };
}
