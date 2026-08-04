/**
 * Publishing a Team Host: the mount, the port, the macsys preflight, and the
 * postcondition probe.
 *
 * These are the gates for properties that CANNOT be observed end-to-end without
 * a real tailnet. Each one is written to fail when its property breaks, not
 * merely when its wording changes — the mount test drives the real
 * `createFunnelOnRunner` and inspects the argv it emits, so changing
 * `TEAM_FUNNEL_MOUNT` to a path makes it fail on the `--set-path` that would
 * then be sent.
 */
import { describe, expect, test } from 'bun:test';

import { createFunnelOnRunner, createFunnelOffRunner } from '@myco/daemon/external-listener.js';
import {
  EXTERNAL_MCP_FUNNEL_PORT,
  TEAM_FUNNEL_MOUNT,
  TEAM_FUNNEL_PORT,
} from '@myco/constants.js';
import { probeHostReachability } from '@myco/host/host-url.js';
import {
  activateTeamFunnel,
  detectTailscaleVariant,
  MACSYS_REMEDY,
  teamFunnelContainmentSockets,
  teamHostingPreflight,
} from '@myco/team-host/funnel.js';

/** A `tailscale` runner that records argv and answers `funnel status` with a
 *  snapshot describing whatever handler the caller just asked for. */
function fakeTailscale(opts: { hostPort?: string; mount?: string; socketPath: string }) {
  const calls: string[][] = [];
  let activated = false;
  const hostPort = opts.hostPort ?? `box.tailnet.ts.net:${TEAM_FUNNEL_PORT}`;
  const mount = opts.mount ?? TEAM_FUNNEL_MOUNT;
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'funnel' && args[1] === 'status') {
      if (!activated) return { stdout: JSON.stringify({ AllowFunnel: {}, Web: {}, TCP: {} }) };
      const port = Number(hostPort.split(':').pop());
      return {
        stdout: JSON.stringify({
          AllowFunnel: { [hostPort]: true },
          Web: { [hostPort]: { Handlers: { [mount]: { Proxy: `unix+http://${opts.socketPath}` } } } },
          TCP: { [String(port)]: { HTTPS: true } },
        }),
      };
    }
    if (args[0] === 'funnel') activated = true;
    if (args[0] === 'serve' && args.includes('off')) activated = false;
    return { stdout: '' };
  };
  return { run, calls, get activated() { return activated; } };
}

const SOCKET = '/tmp/myco-team-test/team.sock';

describe('team Funnel activation', () => {
  test('activates at the ROOT mount — no --set-path is ever sent', async () => {
    const ts = fakeTailscale({ socketPath: SOCKET });
    const result = await activateTeamFunnel(SOCKET, {
      runFunnelOn: createFunnelOnRunner(ts.run),
      probe: { request: async () => ({ status: 401, protocolVersion: null }) },
    });

    expect(result.ok).toBe(true);
    const funnelCall = ts.calls.find((args) => args[0] === 'funnel' && args[1] === '--bg');
    expect(funnelCall).toBeDefined();
    // The property: a mount prefix would make Funnel strip it before proxying,
    // rewriting every pathname the member→host route table keys on. Asserting
    // on the ARGV means a change to TEAM_FUNNEL_MOUNT fails here.
    expect(funnelCall!.some((arg) => arg.startsWith('--set-path'))).toBe(false);
    expect(funnelCall).toContain(`unix:${SOCKET}`);
  });

  test('activates on the team port, which is NOT the external-MCP port', async () => {
    const ts = fakeTailscale({ socketPath: SOCKET });
    await activateTeamFunnel(SOCKET, {
      runFunnelOn: createFunnelOnRunner(ts.run),
      probe: { request: async () => ({ status: 401, protocolVersion: null }) },
    });

    const funnelCall = ts.calls.find((args) => args[0] === 'funnel' && args[1] === '--bg')!;
    expect(funnelCall).toContain(`--https=${TEAM_FUNNEL_PORT}`);
    // Two Myco funnels on one public port would steal each other's traffic:
    // Funnel routes by longest path prefix, and the team surface is at root, so
    // it would swallow `/mcp`.
    expect(TEAM_FUNNEL_PORT).not.toBe(EXTERNAL_MCP_FUNNEL_PORT);
  });

  test('the published URL keeps its port — a team host is not on 443', async () => {
    const ts = fakeTailscale({ socketPath: SOCKET });
    const result = await activateTeamFunnel(SOCKET, {
      runFunnelOn: createFunnelOnRunner(ts.run),
      probe: { request: async () => ({ status: 401, protocolVersion: null }) },
    });
    // Dropping the port would hand members an address that reaches the
    // external-MCP surface (different token, different allowlist) or nothing.
    expect(result.hostUrl).toBe(`https://box.tailnet.ts.net:${TEAM_FUNNEL_PORT}`);
  });

  test('an off-runner removes a ROOT-mounted handler — the inverse speaks the same argv', async () => {
    const ts = fakeTailscale({ socketPath: SOCKET });
    await createFunnelOnRunner(ts.run)(
      { kind: 'socket', path: SOCKET },
      { mount: TEAM_FUNNEL_MOUNT, publicPort: TEAM_FUNNEL_PORT },
    );
    expect(ts.activated).toBe(true);

    ts.calls.length = 0;
    const off = await createFunnelOffRunner(ts.run)({ kind: 'socket', path: SOCKET });

    expect(off.ok).toBe(true);
    // An off-runner that sent `--set-path=/` against a handler activated
    // WITHOUT one would address a different handler and leave the real one
    // published — the failure mode that makes on/off argv agreement matter.
    for (const call of ts.calls.filter((args) => args[0] === 'serve')) {
      expect(call.some((arg) => arg.startsWith('--set-path'))).toBe(false);
    }
  });
});

describe('the postcondition probe', () => {
  test('an unauthenticated 401 is SUCCESS — it proves the daemon answered', async () => {
    const ts = fakeTailscale({ socketPath: SOCKET });
    const result = await activateTeamFunnel(SOCKET, {
      runFunnelOn: createFunnelOnRunner(ts.run),
      probe: { request: async () => ({ status: 401, protocolVersion: null }) },
    });
    expect(result.ok).toBe(true);
    expect(result.hostUrl).toBeTruthy();
  });

  test('a 502 fails the activation and names the macsys remedy', async () => {
    const ts = fakeTailscale({ socketPath: SOCKET });
    const result = await activateTeamFunnel(SOCKET, {
      runFunnelOn: createFunnelOnRunner(ts.run),
      probe: { request: async () => ({ status: 502, protocolVersion: null }) },
    });
    // The macsys signature: the funnel config took, the edge published, and
    // nothing answers behind it. Reporting a generic unreachable host here
    // would send the operator to debug a network that is fine.
    expect(result.ok).toBe(false);
    expect(result.hostUrl).toBeUndefined();
    expect(result.detail).toContain(MACSYS_REMEDY);
  });

  test('a successful ACTIVATION with a dead socket is still a failure', async () => {
    // The whole reason the probe exists: `funnel status` reporting the handler
    // is not evidence that anything serves it.
    const ts = fakeTailscale({ socketPath: SOCKET });
    const result = await activateTeamFunnel(SOCKET, {
      runFunnelOn: createFunnelOnRunner(ts.run),
      probe: {
        request: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
        canConnect: async () => false,
      },
    });
    expect(result.ok).toBe(false);
  });
});

describe('the macsys preflight', () => {
  test('refuses a CLI resolving inside an app bundle', () => {
    const variant = detectTailscaleVariant({
      platform: 'darwin',
      resolveCliPath: () => '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    });
    expect(variant).toBe('sandboxed');
    expect(teamHostingPreflight({
      platform: 'darwin',
      resolveCliPath: () => '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    })).toBe(MACSYS_REMEDY);
  });

  test('allows a standalone CLI, and does not guess when it cannot tell', () => {
    expect(detectTailscaleVariant({ platform: 'darwin', resolveCliPath: () => '/usr/local/bin/tailscale' }))
      .toBe('standalone');
    // No CLI found, and non-darwin, both mean NO CONCLUSION — never a refusal,
    // because a preflight that guessed wrong would block hosting outright.
    expect(detectTailscaleVariant({ platform: 'darwin', resolveCliPath: () => null })).toBe('unknown');
    expect(detectTailscaleVariant({ platform: 'linux', resolveCliPath: () => '/x/Tailscale.app/t' })).toBe('unknown');
    expect(teamHostingPreflight({ platform: 'linux', resolveCliPath: () => null })).toBeNull();
  });
});

describe('team Funnel containment targets', () => {
  const socketFor = () => '/tmp/myco-team-x/team.sock';

  test('a machine that never hosted contributes NOTHING', () => {
    // Load-bearing: a non-empty result makes `requiresContainment` true, which
    // is what reaches the operator's vendor `tailscale` CLI. A clean machine
    // must never spawn it.
    for (const intent of ['retire', 'quiesce'] as const) {
      expect(teamFunnelContainmentSockets({
        mycoHome: '/tmp/none',
        intent,
        hostServeEnabled: () => false,
        hostStatePresent: () => false,
        resolveSocketPath: socketFor,
      })).toEqual([]);
    }
  });

  test('shutdown quiesces a SERVING host; boot leaves it alone', () => {
    const serving = { mycoHome: '/tmp/h', hostServeEnabled: () => true, hostStatePresent: () => true, resolveSocketPath: socketFor };
    // Down means nothing should answer the public URL.
    expect(teamFunnelContainmentSockets({ ...serving, intent: 'quiesce' })).toEqual([socketFor()]);
    // Boot must NOT drive off an exposure that is intended — activation
    // re-verifies it after the listener binds, and driving it off first would
    // take the URL down and back up on every single boot.
    expect(teamFunnelContainmentSockets({ ...serving, intent: 'retire' })).toEqual([]);
  });

  test('boot retires a crashed disable — hosting off, host state still on disk', () => {
    expect(teamFunnelContainmentSockets({
      mycoHome: '/tmp/h',
      intent: 'retire',
      hostServeEnabled: () => false,
      hostStatePresent: () => true,
      resolveSocketPath: socketFor,
    })).toEqual([socketFor()]);
  });
});

describe('reachability classification', () => {
  const UNREACHED = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const dead = async () => { throw UNREACHED; };

  test('a name that does not resolve reports a RENAME, not a network problem', async () => {
    // Classified by asking the resolver, never by reading the failed request's
    // error code: a resolver that answers NXDOMAIN with an address (captive
    // portal, some ISPs, a search-domain suffix) yields ECONNREFUSED for a name
    // that does not exist. Inferring from the code sent the user to debug their
    // network when the host had simply been renamed.
    const result = await probeHostReachability('https://gone.tailnet.ts.net:8443', {
      request: dead,
      resolves: async () => false,
      canConnect: async () => true,
    });
    expect(result).toMatchObject({ state: 'unreachable', reason: 'address_changed' });
    expect(result.detail).toContain('re-join');
  });

  test('a resolvable host whose team port is blocked names the PORT', async () => {
    const result = await probeHostReachability('https://box.tailnet.ts.net:8443', {
      request: dead,
      resolves: async () => true,
      // The edge answers on the port every network permits; ours does not.
      canConnect: async (_h, port) => port === EXTERNAL_MCP_FUNNEL_PORT,
    });
    expect(result).toMatchObject({ state: 'unreachable', reason: 'port_blocked' });
    expect(result.detail).toContain(String(TEAM_FUNNEL_PORT));
  });

  test('a resolvable host with no route at all is a network problem, not a blocked port', async () => {
    const result = await probeHostReachability('https://box.tailnet.ts.net:8443', {
      request: dead,
      resolves: async () => true,
      canConnect: async () => false,
    });
    expect(result).toMatchObject({ state: 'unreachable', reason: 'network_unreachable' });
  });

  test('a record with no address is UNKNOWN — never a claim the host is down', async () => {
    const result = await probeHostReachability(undefined);
    expect(result.state).toBe('unknown');
    expect(result.detail).toContain('Re-join');
  });
});
