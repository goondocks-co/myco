/**
 * Publishing a Team Host: putting its private socket behind a public HTTPS URL.
 *
 * The daemon binds the team listener on a unix socket inside a `0700` directory
 * (`daemon/server.ts` `startTeamListener`). That socket is unreachable from off
 * the machine by construction, which is the containment story — and also means a
 * host serves nobody until a Tailscale Funnel fronts it. This module is that
 * step, and its inverse.
 *
 * ROOT MOUNT, {@link TEAM_FUNNEL_PORT}. Both are load-bearing rather than
 * defaults: a non-root mount makes Funnel strip its prefix, rewriting every
 * pathname the member→host route table keys on, and the port is separate from
 * the external-MCP surface's because Funnel routes by longest path prefix — two
 * Myco funnels on one port would steal each other's traffic.
 *
 * THE 401 IS THE SUCCESS SIGNAL. After activation the host probes its OWN public
 * URL with no credentials. A 401 proves the whole path works: the edge routed to
 * the socket, the daemon answered, and its token gate refused an anonymous
 * caller. A 502 means the edge could not reach the socket at all — which is what
 * the sandboxed macOS System-Extension tailscaled does, silently, after
 * accepting the funnel config. Nobody should ever "fix" that 401 into a 200.
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadMachineConfig } from '@myco/config/loader.js';
import { resolveTeamSocketPath } from '@myco/grove/paths.js';

import { TEAM_FUNNEL_MOUNT, TEAM_FUNNEL_PORT } from '../constants.js';
import type { FunnelOffRunner, FunnelOnRunner } from '../daemon/external-mcp-containment.js';
import { probeHostReachability, type HostProbeDeps } from '../host/host-url.js';
import { readHostState } from './state.js';

/** What the operator must do when their Tailscale cannot serve a unix socket. */
export const MACSYS_REMEDY =
  'This machine runs the sandboxed App Store / System Extension build of Tailscale, which accepts a '
  + 'unix-socket Funnel and then cannot proxy to it. Install the standalone (open-source) tailscaled '
  + 'and retry — team hosting needs a Tailscale that can reach a local socket.';

export type TailscaleVariant =
  /** A Tailscale whose CLI lives outside an app bundle — can serve a socket. */
  | 'standalone'
  /** The sandboxed App Store / System Extension build. Cannot serve a socket. */
  | 'sandboxed'
  /** No conclusion — the CLI was not found, or its location says nothing. */
  | 'unknown';

/**
 * Identify the Tailscale build, well enough to refuse the one that cannot work.
 *
 * HEURISTIC, and deliberately one-sided: the sandboxed build installs its CLI as
 * a symlink into `Tailscale.app`, so a CLI resolving inside an app bundle is a
 * positive identification. Anything else returns `'unknown'` rather than
 * asserting `'standalone'` — there is no metadata that distinguishes the builds
 * (`tailscale version` reports the same fields for both), and this check runs on
 * machines this project has no fixture for.
 *
 * That one-sidedness is why it is a preflight and not the gate: it converts the
 * cases it CAN recognize into an actionable refusal before any durable write,
 * and {@link activateTeamFunnel}'s postcondition probe catches the rest by
 * observing the failure directly instead of predicting it.
 */
export function detectTailscaleVariant(
  deps: { platform?: NodeJS.Platform; resolveCliPath?: () => string | null } = {},
): TailscaleVariant {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return 'unknown';
  const cliPath = (deps.resolveCliPath ?? resolveTailscaleCliPath)();
  if (!cliPath) return 'unknown';
  return cliPath.split(path.sep).some((segment) => segment.endsWith('.app'))
    ? 'sandboxed'
    : 'standalone';
}

/** Where `tailscale` on PATH actually points, following symlinks. Null when it
 *  is not on PATH or cannot be resolved — both "no conclusion". */
function resolveTailscaleCliPath(): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'tailscale');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch { /* not here, or not executable — keep looking */ }
  }
  return null;
}

/**
 * The hosting preflight: refuse before any durable write when this machine's
 * Tailscale positively cannot serve a socket.
 *
 * Returns the refusal message, or null to proceed. Proceeding is NOT a claim
 * that activation will succeed — see {@link detectTailscaleVariant}.
 */
export function teamHostingPreflight(
  deps: { platform?: NodeJS.Platform; resolveCliPath?: () => string | null } = {},
): string | null {
  return detectTailscaleVariant(deps) === 'sandboxed' ? MACSYS_REMEDY : null;
}

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
 * Publish the team socket and verify it actually serves.
 *
 * Two steps that must not be collapsed: activation asks Tailscale to route the
 * public URL to the socket, and the probe checks that it does. Only the second
 * can fail the way the sandboxed build fails — by accepting the request and then
 * not proxying — so an activation that reports success is not evidence the host
 * is reachable, and this returns ok only when the probe agrees.
 */
export async function activateTeamFunnel(
  socketPath: string,
  deps: TeamFunnelDeps,
): Promise<TeamFunnelActivation> {
  const activation = await deps.runFunnelOn(
    { kind: 'socket', path: socketPath },
    { mount: TEAM_FUNNEL_MOUNT, publicPort: TEAM_FUNNEL_PORT },
  );
  if (!activation.ok || !activation.funnelUrl) {
    return {
      ok: false,
      detail: activation.detail || 'the public Funnel did not activate for the team socket',
    };
  }

  const reachability = await probeHostReachability(activation.funnelUrl, deps.probe);
  if (reachability.state === 'reachable') {
    return { ok: true, hostUrl: activation.funnelUrl, detail: reachability.detail };
  }
  // `host_not_serving` after a SUCCESSFUL activation is the macsys signature:
  // the config took, the edge published, and nothing answers behind it. Say so
  // with the remedy rather than reporting a generic unreachable host — the
  // operator is standing at the machine that cannot serve.
  const remedy = reachability.state === 'unreachable' && reachability.reason === 'host_not_serving'
    ? ` ${MACSYS_REMEDY}`
    : '';
  return {
    ok: false,
    detail: `${activation.funnelUrl} was published but did not verify: ${reachability.detail}${remedy}`,
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
 * `additionalFunnelSockets` wiring derives its intent HERE.
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
 * The team Funnel targets containment must drive off for THIS `MYCO_HOME`, or
 * NOTHING.
 *
 * The empty return is the important case. A non-empty result makes
 * `requiresContainment` true, and that is what reaches the operator's vendor
 * `tailscale` CLI; a daemon that has never hosted must never spawn it.
 *
 * SCOPING IS THE SUBTLE PART. The socket path is derived from `MYCO_HOME`, so
 * the evidence has to be too, or the two describe different machines. Host
 * state (`~/.myco-team`) is deliberately machine-GLOBAL and shared by every
 * daemon on the box — reading it here made a second daemon (the two-MYCO_HOME
 * dogfood setup) conclude it had hosted because the FIRST one had, then hand
 * back its own unrelated socket path: the vendor CLI spawned on a daemon that
 * never hosted, and the residue it was looking for went unfound. Both signals
 * therefore come from the mycoHome-scoped machine config: `enabled` for what is
 * published now, `last_served_grove_id` (written by disable) for what this home
 * published before.
 */
export function teamFunnelContainmentSockets(deps: {
  mycoHome: string;
  intent: TeamFunnelContainmentIntent;
  hostServeEnabled?: () => boolean;
  /** Did THIS `MYCO_HOME` ever host? See the scoping note above. */
  hostedBefore?: () => boolean;
  resolveSocketPath?: (mycoHome: string) => string;
}): string[] {
  const readHostServe = (): { enabled: boolean; hostedBefore: boolean } => {
    try {
      const hostServe = loadMachineConfig(deps.mycoHome).daemon.host_serve;
      return {
        enabled: hostServe.enabled === true,
        hostedBefore: typeof hostServe.last_served_grove_id === 'string'
          && hostServe.last_served_grove_id.length > 0,
      };
    } catch {
      // Unreadable config is not evidence of absence — but it is also not
      // evidence of exposure, and guessing "hosted" here would reach the
      // vendor CLI on a machine mid-edit. Fail toward doing nothing.
      return { enabled: false, hostedBefore: false };
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
  return [(deps.resolveSocketPath ?? resolveTeamSocketPath)(deps.mycoHome)];
}

/** Withdraw the team socket's public URL. The bounded inverse of
 *  {@link activateTeamFunnel}, run when hosting is disabled and at shutdown so
 *  nothing answers the public URL while the daemon is down. */
export async function deactivateTeamFunnel(
  socketPath: string,
  runFunnelOff: FunnelOffRunner,
): Promise<{ ok: boolean; detail: string }> {
  return await runFunnelOff({ kind: 'socket', path: socketPath });
}
