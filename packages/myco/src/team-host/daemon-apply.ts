/**
 * Wire host-serve enablement into the running daemon.
 *
 * Two steps, both idempotent:
 *   1. WRITE `daemon.host_serve = { enabled, overlay_address }` to the MACHINE
 *      tier via the raw machine-tier writer. Daemon startup reads this field and
 *      binds a second overlay listener. The overlay address MUST be a 100.64/10
 *      CGNAT IP; `isOverlayRangeAddress` refuses any other address at the write
 *      boundary.
 *   2. APPLY it by restarting the daemon. Host-serve is read once at startup
 *      (`daemon/main.ts`), so a config write alone is inert — the daemon must
 *      restart to bind (or unbind) the overlay listener. The `myco` CLI process
 *      running `host enable` is separate from the daemon, so restarting via the
 *      platform ServiceManager is the safe path (no self-SIGTERM). When the
 *      daemon is not service-managed we surface a manual-restart instruction
 *      rather than failing.
 *
 * The write is machine-tier and machine-global; there is no project vault context
 * in `host enable`, so the machine-tier writer validates, serializes, and
 * atomically persists the host-serve leaf without replacing sibling state.
 */
import { updateTierConfigRaw } from '@myco/config/loader.js';
import { isOverlayRangeAddress, isValidOverlayPort } from '@myco/daemon/host-serve.js';
import { resolveMycoHome } from '@myco/grove/paths.js';
import { getServiceManager } from '@myco/service/manager.js';
import { serviceLabel } from '@myco/service/labels.js';
import type { ServiceManager } from '@myco/service/types.js';

export interface HostServeApply {
  enabled: boolean;
  /** The host's 100.64/10 overlay IP when enabling; null clears it (disable). */
  overlayAddress: string | null;
  /**
   * The overlay listener's loopback port / serve-forward port. REQUIRED when
   * enabling — the daemon refuses to serve without it. This write replaces the
   * whole `host_serve` leaf, so a field omitted here is DESTROYED; that is why
   * it is listed explicitly rather than left to merge.
   */
  overlayPort?: number | null;
  /** Host identity mirrored into `host_serve` for the enrollment endpoint. */
  hostId?: string | null;
  label?: string | null;
  /** The one Grove this host serves; cleared when host serving is disabled. */
  servedGroveId?: string | null;
}

/**
 * Persist the host-serve enablement to the machine tier. Refuses to write an
 * enabled config whose address is not a 100.64/10 overlay IP, matching the
 * listener's downstream bind gate.
 */
export function writeHostServeConfig(apply: HostServeApply, mycoHome: string = resolveMycoHome()): void {
  if (apply.enabled && !isValidOverlayPort(apply.overlayPort)) {
    throw new Error(
      `Refusing to enable host-serve: overlay_port ${JSON.stringify(apply.overlayPort ?? null)} is not a `
      + 'valid port. Without it the daemon fails closed and never binds the overlay listener.',
    );
  }
  if (apply.enabled && !isOverlayRangeAddress(apply.overlayAddress)) {
    throw new Error(
      `Refusing to enable host-serve: overlay_address ${JSON.stringify(apply.overlayAddress)} is not a `
      + '100.64.0.0/10 (CGNAT) overlay IP. Members would have no address to dial.',
    );
  }
  updateTierConfigRaw({ kind: 'machine' }, (raw) => {
    const daemon = raw.daemon;
    if (daemon !== undefined && (daemon === null || typeof daemon !== 'object' || Array.isArray(daemon))) {
      throw new Error('daemon must be a mapping');
    }
    raw.daemon = {
      ...(daemon as Record<string, unknown> | undefined),
      host_serve: {
        enabled: apply.enabled,
        overlay_address: apply.enabled ? apply.overlayAddress : null,
        overlay_port: apply.enabled ? (apply.overlayPort ?? null) : null,
        host_id: apply.enabled ? (apply.hostId ?? null) : null,
        label: apply.enabled ? (apply.label ?? null) : null,
        served_grove_id: apply.enabled ? (apply.servedGroveId ?? null) : null,
      },
    };
  }, { mycoHome });
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
