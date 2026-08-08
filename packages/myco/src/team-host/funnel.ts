/**
 * Publishing a Team Host: putting its loopback listener behind a public HTTPS URL.
 *
 * The daemon binds the team listener on `127.0.0.1` (`daemon/server.ts`
 * `startTeamListener`). That port is unreachable from off the machine, so a host
 * serves nobody until a Tailscale Funnel fronts it. This module is that step,
 * and its inverse.
 *
 * ROOT MOUNT, {@link TEAM_FUNNEL_PORT}. Both are load-bearing rather than
 * defaults: a non-root mount makes Funnel strip its prefix, rewriting every
 * pathname the member→host route table keys on, and the port is separate from
 * the external-MCP surface's because Funnel routes by longest path prefix — two
 * Myco funnels on one port would steal each other's traffic.
 *
 * THE 401 IS THE SUCCESS SIGNAL. After activation the host probes its OWN public
 * URL with no credentials. A 401 proves the whole path works: the edge routed to
 * the listener, the daemon answered, and its token gate refused an anonymous
 * caller. A 502 means the edge could not reach the listener at all. Nobody
 * should ever "fix" that 401 into a 200.
 *
 * A LOOPBACK PORT, NOT A UNIX SOCKET, and the reason is measured. The macOS App
 * Store / System Extension Tailscale — the default install — accepts a
 * unix-socket Funnel configuration and then cannot proxy to it: the edge
 * publishes and nothing answers behind it. Verified on one node with everything
 * else held constant, Funnel to a socket returned 502 while Funnel to a loopback
 * port on the same daemon returned 200. Serving a socket meant hosting did not
 * work at all for most Mac operators. See `daemon/server.ts` `startTeamListener`
 * for what the change costs and why the bearer token, not the socket, is the
 * admission control.
 */
import { loadMachineConfig } from '@myco/config/loader.js';

import { TEAM_FUNNEL_MOUNT, TEAM_FUNNEL_PORT } from '../constants.js';
import type { FunnelOffRunner, FunnelOnRunner, FunnelTarget } from '../daemon/external-mcp-containment.js';
import { probeHostReachability, type HostProbeDeps } from '../host/host-url.js';
import { readHostState } from './state.js';

export interface TeamFunnelActivation {
  ok: boolean;
  /** The host's public URL, present only when ok. This is the address members
   *  store, and the host's identity as far as they are concerned. */
  hostUrl?: string;
  detail: string;
}

export interface TeamFunnelDeps {
  runFunnelOn: FunnelOnRunner;
  /** Probe the host's own public URL. Injected as a whole so tests drive the
   *  401/502 distinction without a network. */
  probe?: HostProbeDeps;
}

/**
 * Publish the team listener's port and verify it actually serves.
 *
 * Two steps that must not be collapsed: activation asks Tailscale to route the
 * public URL to the port, and the probe checks that it does. An activation that
 * reports success is not evidence the host is reachable — the edge can accept a
 * configuration and still fail to reach what is behind it — so this returns ok
 * only when the probe agrees.
 */
export async function activateTeamFunnel(
  port: number,
  deps: TeamFunnelDeps,
): Promise<TeamFunnelActivation> {
  const activation = await deps.runFunnelOn(
    { kind: 'port', port },
    { mount: TEAM_FUNNEL_MOUNT, publicPort: TEAM_FUNNEL_PORT },
  );
  if (!activation.ok || !activation.funnelUrl) {
    return {
      ok: false,
      detail: activation.detail || 'the public Funnel did not activate for the team listener',
    };
  }

  const reachability = await probeHostReachability(activation.funnelUrl, deps.probe);
  if (reachability.state === 'reachable') {
    return { ok: true, hostUrl: activation.funnelUrl, detail: reachability.detail };
  }
  return {
    ok: false,
    detail: `${activation.funnelUrl} was published but did not verify: ${reachability.detail}`,
  };
}

/**
 * What a containment pass is FOR, on the team surface. The two answers differ,
 * and collapsing them would either flap the public URL on every boot or leave
 * it published after the daemon stops.
 */
export type TeamFunnelContainmentIntent =
  /** Daemon shutdown: stop serving. Hosting stays configured and the next boot
   *  republishes; while the daemon is down, nothing answers the URL. */
  | 'quiesce'
  /** Boot reconcile: remove exposure that should NOT exist. An enabled host is
   *  left alone here — its Funnel is verified/repaired after the listener binds
   *  (`activateTeamFunnel`), and driving it off first would take the URL down
   *  and back up on every single boot. */
  | 'retire';

/**
 * Which containment intent a given operation implies for the team surface.
 *
 * Exists as a named function, rather than a conditional at each wiring site,
 * because getting it wrong is invisible: one authority instance serves both the
 * boot reconcile and the daemon's own graceful shutdown, and a site that picked
 * an intent once — at construction — answered the boot question for both. The
 * shutdown then withdrew nothing and a stopped host kept its public URL. Every
 * `additionalFunnelPorts` wiring derives its intent HERE.
 */
export function teamFunnelIntentFor(
  operation: 'retire' | 'reconcile' | 'disable' | 'shutdown',
): TeamFunnelContainmentIntent {
  // Only a shutdown is "stop serving what is currently published". Boot
  // reconcile, an explicit disable, and a retire are all "remove exposure that
  // should not exist" — an enabled host's Funnel is intended in each.
  return operation === 'shutdown' ? 'quiesce' : 'retire';
}

/**
 * The team Funnel ports containment must drive off for THIS `MYCO_HOME`, or
 * NOTHING.
 *
 * The empty return is the important case. A non-empty result makes
 * `requiresContainment` true, and that is what reaches the operator's vendor
 * `tailscale` CLI; a daemon that has never hosted must never spawn it.
 *
 * SCOPING IS THE SUBTLE PART, and it is why the PORT lives in the mycoHome-scoped
 * machine config rather than the machine-global host state. Host state
 * (`~/.myco-team`) is shared by every daemon on the box — reading it here made a
 * second daemon (the two-MYCO_HOME dogfood setup) conclude it had hosted because
 * the FIRST one had, then hand back its own unrelated target: the vendor CLI
 * spawned on a daemon that never hosted, and the residue it was looking for went
 * unfound. Every signal therefore comes from the mycoHome-scoped config —
 * `enabled` for what is published now, `last_served_grove_id` (written by
 * disable) for what this home published before, and `team_port` for WHICH
 * handler is ours.
 */
export function teamFunnelContainmentPorts(deps: {
  mycoHome: string;
  intent: TeamFunnelContainmentIntent;
  hostServeEnabled?: () => boolean;
  /** Did THIS `MYCO_HOME` ever host? See the scoping note above. */
  hostedBefore?: () => boolean;
  /** Test seam: the port this home published. */
  resolveTeamPort?: (mycoHome: string) => number | null;
}): number[] {
  const readHostServe = (): { enabled: boolean; hostedBefore: boolean; port: number | null } => {
    try {
      const hostServe = loadMachineConfig(deps.mycoHome).daemon.host_serve;
      return {
        enabled: hostServe.enabled === true,
        hostedBefore: typeof hostServe.last_served_grove_id === 'string'
          && hostServe.last_served_grove_id.length > 0,
        port: typeof hostServe.team_port === 'number' ? hostServe.team_port : null,
      };
    } catch {
      // Unreadable config is not evidence of absence — but it is also not
      // evidence of exposure, and guessing "hosted" here would reach the
      // vendor CLI on a machine mid-edit. Fail toward doing nothing.
      return { enabled: false, hostedBefore: false, port: null };
    }
  };
  const config = readHostServe();
  const enabled = deps.hostServeEnabled?.() ?? config.enabled;
  const hostedBefore = deps.hostedBefore?.() ?? config.hostedBefore;

  if (deps.intent === 'quiesce') {
    // Stopping: withdraw whatever this home is currently publishing.
    if (!enabled) return [];
  } else {
    // Boot: retire exposure that should NOT exist. An enabled host's Funnel is
    // intended and is verified after the listener binds; what this catches is
    // the crashed-disable shape, where hosting is off but this home hosted
    // before and may still have a live handler.
    if (enabled || !hostedBefore) return [];
  }
  // No remembered port means this home has no handler to name. Returning
  // nothing keeps `requiresContainment` false rather than spawning the vendor
  // CLI to remove something that cannot be identified.
  const port = deps.resolveTeamPort ? deps.resolveTeamPort(deps.mycoHome) : config.port;
  return port === null ? [] : [port];
}

/** Withdraw the team listener's public URL. The bounded inverse of
 *  {@link activateTeamFunnel}, run when hosting is disabled and at shutdown so
 *  nothing answers the public URL while the daemon is down. */
export async function deactivateTeamFunnel(
  target: FunnelTarget,
  runFunnelOff: FunnelOffRunner,
): Promise<{ ok: boolean; detail: string }> {
  return await runFunnelOff(target);
}
