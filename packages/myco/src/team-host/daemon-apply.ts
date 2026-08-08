/**
 * Wire host-serve enablement into the running daemon.
 *
 * Two steps, both idempotent:
 *   1. WRITE `daemon.host_serve = { enabled, host_id, label, served_grove_id }`
 *      to the MACHINE tier via the raw machine-tier writer. Daemon startup reads
 *      this field and binds the team listener on its socket.
 *   2. APPLY it by restarting the daemon. Host-serve is read once at startup
 *      (`daemon/main.ts`), so a config write alone is inert — the daemon must
 *      restart to bind (or unbind) the team listener. The `myco` CLI process
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
import { resolveMycoHome } from '@myco/grove/paths.js';
import { getServiceManager } from '@myco/service/manager.js';
import type { ServiceManager } from '@myco/service/types.js';

export interface HostServeApply {
  enabled: boolean;
  /** Host identity mirrored into `host_serve` for the enrollment endpoint. */
  hostId?: string | null;
  label?: string | null;
  /** The one Grove this host serves; cleared when host serving is disabled. */
  servedGroveId?: string | null;
}

/**
 * Persist the host-serve enablement to the machine tier.
 *
 * There is no address to validate here. The team listener claims a loopback
 * port at bind time and records it separately ({@link rememberTeamPort}), so
 * enablement carries identity and designation only — what a host IS, not where
 * it can be reached.
 */
export function writeHostServeConfig(apply: HostServeApply, mycoHome: string = resolveMycoHome()): void {
  updateTierConfigRaw({ kind: 'machine' }, (raw) => {
    const daemon = raw.daemon;
    if (daemon !== undefined && (daemon === null || typeof daemon !== 'object' || Array.isArray(daemon))) {
      throw new Error('daemon must be a mapping');
    }
    // On DISABLE, remember the outgoing served grove: a later fresh-mode
    // enable adopts the team's existing storage instead of orphaning it
    // (with its whole attached history) and then crashing on the name
    // collision. Consumed (nulled) by the next enable.
    const prior = (daemon as Record<string, unknown> | undefined)?.host_serve as
      | Record<string, unknown>
      | undefined;
    const lastServed = apply.enabled
      ? null
      : ((typeof prior?.served_grove_id === 'string' && prior.served_grove_id) || (typeof prior?.last_served_grove_id === 'string' && prior.last_served_grove_id) || null);
    raw.daemon = {
      ...(daemon as Record<string, unknown> | undefined),
      host_serve: {
        enabled: apply.enabled,
        host_id: apply.enabled ? (apply.hostId ?? null) : null,
        label: apply.enabled ? (apply.label ?? null) : null,
        served_grove_id: apply.enabled ? (apply.servedGroveId ?? null) : null,
        last_served_grove_id: lastServed,
        // CARRIED THROUGH DISABLE, not cleared with it. The port names this
        // home's Funnel handler for containment, and the case containment most
        // needs it for is the crashed disable — hosting off, a handler still
        // live. Clearing it here would erase the only thing that can identify
        // that handler as ours.
        team_port: typeof prior?.team_port === 'number' ? prior.team_port : null,
      },
    };
  }, { mycoHome });
}

/**
 * Record the loopback port the team listener just bound.
 *
 * A narrow write rather than a `writeHostServeConfig` call: this runs at every
 * boot that binds, and must not disturb the enable/disable fields that flow
 * owns. Creates the `host_serve` block if a bind somehow precedes an enable.
 */
export function rememberTeamPort(port: number, mycoHome: string = resolveMycoHome()): void {
  updateTierConfigRaw({ kind: 'machine' }, (raw) => {
    const daemon = raw.daemon;
    if (daemon !== undefined && (daemon === null || typeof daemon !== 'object' || Array.isArray(daemon))) {
      throw new Error('daemon must be a mapping');
    }
    const prior = (daemon as Record<string, unknown> | undefined)?.host_serve as
      | Record<string, unknown>
      | undefined;
    if (prior?.team_port === port) return;
    raw.daemon = {
      ...(daemon as Record<string, unknown> | undefined),
      host_serve: { ...(prior ?? {}), team_port: port },
    };
  }, { mycoHome });
}

export interface DaemonRestartResult {
  restarted: boolean;
  detail: string;
}

/**
 * Restart the daemon so it re-reads host-serve and (un)binds the team listener.
 * Uses the platform ServiceManager (a separate-process restart — safe, no
 * self-SIGTERM). When the daemon is not installed as a service, returns
 * `restarted:false` with an operator instruction instead of throwing.
 */
export async function restartDaemonForHostServe(
  mycoHome: string = resolveMycoHome(),
  manager: ServiceManager = getServiceManager(),
): Promise<DaemonRestartResult> {
  if (!manager.supported) {
    return { restarted: false, detail: `Restart the Myco daemon manually to apply host-serve (${manager.platformName}).` };
  }
  // OWNING-domain probe (spec R-B1, adopted from daemon/api/restart.ts): a
  // boot-scoped daemon has no login unit, and a bare `isInstalled` against
  // the login manager reported `restarted:false` on exactly the always-on
  // host this release recommends — telling the operator to restart by hand
  // after every enable (E1 review, RC4/G5).
  const { findInstalledServiceLabel } = await import('@myco/daemon/api/restart.js');
  const found = await findInstalledServiceLabel(manager, mycoHome);
  if (!found) {
    return {
      restarted: false,
      detail: 'The Myco daemon is not installed as a managed service; restart it manually (`myco restart`) to apply host-serve.',
    };
  }
  try {
    await found.manager.restart(found.label);
  } catch (err) {
    // Fourth failure state (E1 §4.1 rev 6): durable state is already
    // written by the caller's reorder, so a failed restart is NOT a failed
    // enable — it is "state written, restart failed, re-run converges".
    return {
      restarted: false,
      detail: `Daemon restart failed (${err instanceof Error ? err.message : String(err)}). `
        + 'Host-serve config is written; restart the daemon (`myco restart`) or re-run `myco host enable` to converge.',
    };
  }
  return { restarted: true, detail: `Restarted the Myco daemon service (${found.label}) to apply host-serve.` };
}
