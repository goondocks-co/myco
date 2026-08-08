/**
 * Publishing a Team Host: the mount, the port, the containment scoping, and the
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFunnelOnRunner, createFunnelOffRunner } from '@myco/daemon/external-listener.js';
import {
  EXTERNAL_MCP_FUNNEL_PORT,
  TEAM_FUNNEL_MOUNT,
  TEAM_FUNNEL_PORT,
} from '@myco/constants.js';
import http from 'node:http';

import { probeHostReachability } from '@myco/host/host-url.js';
import { startFunnelEdge } from '../helpers/funnel-edge.js';
import {
  activateTeamFunnel,
  teamFunnelContainmentPorts,
  teamFunnelIntentFor,
} from '@myco/team-host/funnel.js';

/** A `tailscale` runner that records argv and answers `funnel status` with a
 *  snapshot describing whatever handler the caller just asked for. */
function fakeTailscale(opts: { hostPort?: string; mount?: string; port: number }) {
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
          Web: { [hostPort]: { Handlers: { [mount]: { Proxy: `http://127.0.0.1:${opts.port}` } } } },
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

/** The loopback port a team listener is pretending to have bound. */
const TEAM_PORT = 45321;

describe('team Funnel activation', () => {
  test('activates at the ROOT mount — no --set-path is ever sent', async () => {
    const ts = fakeTailscale({ port: TEAM_PORT });
    const result = await activateTeamFunnel(TEAM_PORT, {
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
    expect(funnelCall).toContain(`http://127.0.0.1:${TEAM_PORT}`);
  });

  test('activates on the team port, which is NOT the external-MCP port', async () => {
    const ts = fakeTailscale({ port: TEAM_PORT });
    await activateTeamFunnel(TEAM_PORT, {
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
    const ts = fakeTailscale({ port: TEAM_PORT });
    const result = await activateTeamFunnel(TEAM_PORT, {
      runFunnelOn: createFunnelOnRunner(ts.run),
      probe: { request: async () => ({ status: 401, protocolVersion: null }) },
    });
    // Dropping the port would hand members an address that reaches the
    // external-MCP surface (different token, different allowlist) or nothing.
    expect(result.hostUrl).toBe(`https://box.tailnet.ts.net:${TEAM_FUNNEL_PORT}`);
  });

  test('a pre-existing handler on a DIFFERENT port does not count as already-activated', async () => {
    // The port is the member's recorded address, so a handler for this socket
    // at the same mount on another port must not satisfy the idempotence check
    // — skipping activation there would publish that other port to every
    // member as `host_url`.
    const ts = fakeTailscale({ port: TEAM_PORT, hostPort: 'box.tailnet.ts.net:10000' });
    // Pre-activate on 10000, the way a hand-edited serve config would look.
    await createFunnelOnRunner(ts.run)(
      { kind: 'port', port: TEAM_PORT },
      { mount: TEAM_FUNNEL_MOUNT, publicPort: 10000 },
    );
    ts.calls.length = 0;

    // Now ask for the team port. It must ACTIVATE rather than short-circuit.
    await createFunnelOnRunner(ts.run)(
      { kind: 'port', port: TEAM_PORT },
      { mount: TEAM_FUNNEL_MOUNT, publicPort: TEAM_FUNNEL_PORT },
    );

    const funnelCall = ts.calls.find((args) => args[0] === 'funnel' && args[1] === '--bg');
    expect(funnelCall).toBeDefined();
    expect(funnelCall).toContain(`--https=${TEAM_FUNNEL_PORT}`);
  });

  test('an off-runner removes a ROOT-mounted handler — the inverse speaks the same argv', async () => {
    const ts = fakeTailscale({ port: TEAM_PORT });
    await createFunnelOnRunner(ts.run)(
      { kind: 'port', port: TEAM_PORT },
      { mount: TEAM_FUNNEL_MOUNT, publicPort: TEAM_FUNNEL_PORT },
    );
    expect(ts.activated).toBe(true);

    ts.calls.length = 0;
    const off = await createFunnelOffRunner(ts.run)({ kind: 'port', port: TEAM_PORT });

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
    const ts = fakeTailscale({ port: TEAM_PORT });
    const result = await activateTeamFunnel(TEAM_PORT, {
      runFunnelOn: createFunnelOnRunner(ts.run),
      probe: { request: async () => ({ status: 401, protocolVersion: null }) },
    });
    expect(result.ok).toBe(true);
    expect(result.hostUrl).toBeTruthy();
  });

  test('a 502 fails the activation — published, but nothing serving behind it', async () => {
    const ts = fakeTailscale({ port: TEAM_PORT });
    const result = await activateTeamFunnel(TEAM_PORT, {
      runFunnelOn: createFunnelOnRunner(ts.run),
      probe: { request: async () => ({ status: 502, protocolVersion: null }) },
    });
    // The funnel config took and the edge published, but nothing answers.
    // Activation reporting success is therefore not evidence of reachability,
    // which is the whole reason the probe is a separate step.
    expect(result.ok).toBe(false);
    expect(result.hostUrl).toBeUndefined();
    expect(result.detail).toContain('did not verify');
  });

  test('a successful ACTIVATION with a dead listener is still a failure', async () => {
    // The whole reason the probe exists: `funnel status` reporting the handler
    // is not evidence that anything serves it.
    const ts = fakeTailscale({ port: TEAM_PORT });
    const result = await activateTeamFunnel(TEAM_PORT, {
      runFunnelOn: createFunnelOnRunner(ts.run),
      probe: {
        request: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
        canConnect: async () => false,
      },
    });
    expect(result.ok).toBe(false);
  });
});


describe('containment intent by operation', () => {
  test('ONLY a shutdown quiesces; every other operation retires', () => {
    // The distinction a stopped host depends on. Boot reconcile must leave an
    // enabled host's Funnel alone (it is re-verified once the listener binds),
    // and shutdown must withdraw it so nothing answers while the daemon is
    // down. One authority serves both, so this mapping is the only thing
    // keeping them apart.
    expect(teamFunnelIntentFor('shutdown')).toBe('quiesce');
    expect(teamFunnelIntentFor('reconcile')).toBe('retire');
    expect(teamFunnelIntentFor('retire')).toBe('retire');
    expect(teamFunnelIntentFor('disable')).toBe('retire');
  });

  test('a SERVING host withdraws on shutdown and holds on boot, via the mapping', () => {
    // End to end through the function the wiring sites call: the pairing of
    // operation → intent → sockets is what shipped broken.
    const serving = {
      mycoHome: '/tmp/h',
      hostServeEnabled: () => true,
      hostedBefore: () => true,
      resolveTeamPort: () => '/tmp/myco-team-x/team.sock',
    };
    expect(teamFunnelContainmentPorts({ ...serving, intent: teamFunnelIntentFor('shutdown') }))
      .toEqual(['/tmp/myco-team-x/team.sock']);
    expect(teamFunnelContainmentPorts({ ...serving, intent: teamFunnelIntentFor('reconcile') }))
      .toEqual([]);
  });
});

describe('team Funnel containment targets', () => {
  const socketFor = () => '/tmp/myco-team-x/team.sock';

  test('a machine that never hosted contributes NOTHING', () => {
    // Load-bearing: a non-empty result makes `requiresContainment` true, which
    // is what reaches the operator's vendor `tailscale` CLI. A daemon that has
    // never hosted must never spawn it.
    for (const intent of ['retire', 'quiesce'] as const) {
      expect(teamFunnelContainmentPorts({
        mycoHome: '/tmp/none',
        intent,
        hostServeEnabled: () => false,
        hostedBefore: () => false,
        resolveTeamPort: socketFor,
      })).toEqual([]);
    }
  });

  test('shutdown quiesces a SERVING host; boot leaves it alone', () => {
    const serving = {
      mycoHome: '/tmp/h',
      hostServeEnabled: () => true,
      hostedBefore: () => true,
      resolveTeamPort: socketFor,
    };
    // Down means nothing should answer the public URL. This is the case that
    // shipped broken: the daemon's own shutdown asked with a boot-shaped intent
    // and withdrew nothing.
    expect(teamFunnelContainmentPorts({ ...serving, intent: 'quiesce' })).toEqual([socketFor()]);
    // Boot must NOT drive off an exposure that is intended — activation
    // re-verifies it after the listener binds, and driving it off first would
    // take the URL down and back up on every single boot.
    expect(teamFunnelContainmentPorts({ ...serving, intent: 'retire' })).toEqual([]);
  });

  test('boot retires a crashed disable — hosting off, but THIS home hosted before', () => {
    expect(teamFunnelContainmentPorts({
      mycoHome: '/tmp/h',
      intent: 'retire',
      hostServeEnabled: () => false,
      hostedBefore: () => true,
      resolveTeamPort: socketFor,
    })).toEqual([socketFor()]);
  });

  test('a stopped daemon that was never enabled quiesces nothing', () => {
    expect(teamFunnelContainmentPorts({
      mycoHome: '/tmp/h',
      intent: 'quiesce',
      hostServeEnabled: () => false,
      hostedBefore: () => true,
      resolveTeamPort: socketFor,
    })).toEqual([]);
  });

  test('the PRODUCTION defaults read the mycoHome-scoped config, not machine-global host state', () => {
    // The scoping bug this pins: the port that names this home's Funnel handler
    // must come from the SAME home as the evidence that it hosted. Host state
    // lives in the machine-global team home shared by EVERY daemon on the box,
    // so a second daemon (the two-MYCO_HOME dogfood setup) read the first one's
    // state, concluded it had hosted, and handed back its own unrelated target
    // — spawning the vendor CLI on a daemon that never hosted while missing the
    // residue it was looking for. It is also why `team_port` lives in the
    // mycoHome-scoped config rather than that shared state. No injected
    // predicates here: the defaults are the subject.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-funnel-scope-'));
    try {
      // A home whose config has never hosted contributes nothing, regardless of
      // any host state elsewhere on the machine.
      fs.writeFileSync(path.join(home, 'config.yaml'), 'daemon:\n  host_serve:\n    enabled: false\n', 'utf-8');
      expect(teamFunnelContainmentPorts({ mycoHome: home, intent: 'retire' })).toEqual([]);
      expect(teamFunnelContainmentPorts({ mycoHome: home, intent: 'quiesce' })).toEqual([]);

      // Hosted before, but NO port on record — nothing identifiable to drive
      // off. Returning a guess here would reach the vendor CLI to remove a
      // handler this home cannot prove is its own.
      fs.writeFileSync(
        path.join(home, 'config.yaml'),
        'daemon:\n  host_serve:\n    enabled: false\n    last_served_grove_id: grove_' + '0'.repeat(32) + '\n',
        'utf-8',
      );
      expect(teamFunnelContainmentPorts({ mycoHome: home, intent: 'retire' })).toEqual([]);

      // The same home AFTER a disable, with the port it published on record —
      // `last_served_grove_id` says this home hosted, `team_port` says which
      // handler was ours. Both are mycoHome-scoped.
      fs.writeFileSync(
        path.join(home, 'config.yaml'),
        'daemon:\n  host_serve:\n    enabled: false\n    last_served_grove_id: grove_' + '0'.repeat(32) + '\n    team_port: 45871\n',
        'utf-8',
      );
      expect(teamFunnelContainmentPorts({ mycoHome: home, intent: 'retire' })).toEqual([45871]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
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

describe('the probe against a SILENT host (the runtime the binary ships on)', () => {
  // Drives the REAL `probeHostReachability` with its REAL default request
  // implementation — no injected `request`. That is the point: every other
  // probe test injects past this seam, and the one code path that touches the
  // runtime is where Bun and Node diverge.
  //
  // Accept-then-never-answer is exactly what a published-but-unserved Funnel
  // does, which is what this probe exists to catch, and
  // it is exactly the shape that hung: the timeout fired but `destroy(err)`
  // emitted no `'error'` under Bun, so the promise was abandoned — stalling
  // boot publication, pinning the Team page on "checking" forever (the
  // single-flight map holds the pending promise), and hanging `myco doctor`.
  test('SETTLES rather than hanging when the host accepts and never answers', async () => {
    const edgeTarget = http.createServer(() => { /* never responds */ });
    await new Promise<void>((r) => edgeTarget.listen(0, '127.0.0.1', () => r()));
    const edge = await startFunnelEdge({ port: (edgeTarget.address() as { port: number }).port });

    try {
      const started = Date.now();
      const settled = await Promise.race([
        probeHostReachability(edge.url, { timeoutMs: 500 }).then(() => 'settled' as const),
        new Promise<'hung'>((r) => setTimeout(() => r('hung'), 5_000)),
      ]);

      expect(settled).toBe('settled');
      // And it settled on ITS OWN bound, not by the race timing out around it.
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      await edge.close();
      // Force sockets shut: the edge's in-flight upstream request to this
      // server is still open (it never got a response, which is the point), and
      // a plain close() waits for it forever.
      (edgeTarget as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => edgeTarget.close(() => r()));
    }
  }, 20_000);
});
