/**
 * The Team Host listener's port lifecycle.
 *
 * This replaces a suite about unix-socket lifecycle — 0700 directory ownership,
 * stale-inode reclaim, live-socket refusal, unlink on teardown. None of that
 * exists any more: the listener binds a loopback TCP port, because the default
 * macOS Tailscale accepts a unix-socket Funnel and then cannot proxy to it (the
 * public URL 502s with no diagnostic).
 *
 * What carried over is the CLASS of claim worth asserting rather than trusting,
 * because this surface is published to the internet: where it binds, that a bind
 * problem degrades instead of wedging the daemon, and that the port survives a
 * restart so publishing does not rewrite the operator's serve config every boot.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { DaemonServer } from '@myco/daemon/server.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const HOST_BEARER = 'team-listener-lifecycle-bearer';

const stubAuthority = {
  read: () => null,
  write: () => {},
  clear: () => {},
} as unknown as ConstructorParameters<typeof DaemonServer>[0]['daemonStateAuthority'];

describe('team listener port lifecycle', () => {
  let tmp: string;
  let servers: DaemonServer[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-life-'));
    servers = [];
    process.env.MYCO_HOME = tmp;
  });

  afterEach(async () => {
    for (const s of servers) await s.stop().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function start(teamPort?: number, opts: { serving?: boolean } = {}): Promise<DaemonServer> {
    const server = new DaemonServer({
      vaultDir: tmp,
      logger: new DaemonLogger(path.join(tmp, `logs-${servers.length}`)),
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
      ...(opts.serving === false ? {} : { hostServe: { bearer: HOST_BEARER } as unknown as ConstructorParameters<typeof DaemonServer>[0]['hostServe'] }),
      ...(teamPort === undefined ? {} : { teamPort }),
    });
    servers.push(server);
    await server.start(0);
    return server;
  }

  /** Can `host` reach the listener at `port`? Resolves false on any error. */
  function reachable(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port });
      const done = (value: boolean) => { sock.destroy(); resolve(value); };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      setTimeout(() => done(false), 1_000).unref?.();
    });
  }

  /** Hold a loopback port for the duration of a test, and hand out its number. */
  async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
    const held = net.createServer();
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve));
    return {
      port: (held.address() as AddressInfo).port,
      release: () => new Promise<void>((resolve) => held.close(() => resolve())),
    };
  }

  test('reports the port it actually bound', async () => {
    // The number a caller may act on — publish a Funnel at, dial in a test —
    // is the one read back off the listener, never one chosen in advance. The
    // report is checked against a connection, not against the value that
    // produced it.
    const server = await start();
    expect(server.teamPort).toBeGreaterThan(0);
    expect(await reachable('127.0.0.1', server.teamPort!)).toBe(true);
  });

  test('binds LOOPBACK ONLY — a routable interface never answers', async () => {
    // The one property a unix socket gave for free and a port does not. An
    // omitted host argument binds every interface, which would put the team
    // surface on the LAN: a second door beside the Funnel, never published.
    const server = await start();
    const port = server.teamPort!;
    expect(port).toBeGreaterThan(0);
    const external = Object.values(os.networkInterfaces())
      .flatMap((ifaces) => ifaces ?? [])
      .find((i) => i.family === 'IPv4' && !i.internal);
    if (!external) return; // no routable address on this machine; nothing to prove
    expect(await reachable(external.address, port)).toBe(false);
  });

  test('a TAKEN port degrades to an ephemeral one — never a refusal to serve', async () => {
    // The remembered port can be claimed by anything between two boots. Falling
    // back keeps the host serving; refusing would strand it on a detail the
    // operator never chose.
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;
    try {
      const server = await start(taken);
      expect(server.teamPort).not.toBeNull();
      expect(server.teamPort).not.toBe(taken);
      expect(await reachable('127.0.0.1', server.teamPort!)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test('host serving OFF binds nothing at all — a configured port included', async () => {
    // The port is one this test HOLDS, so "the daemon never touched it" is a
    // fact about a live socket rather than about an unclaimed number: had
    // serving been on, that bind would have collided and fallen back.
    const held = await holdPort();
    try {
      const server = await start(held.port, { serving: false });
      expect(server.teamPort).toBeNull();
      expect(await reachable('127.0.0.1', held.port)).toBe(true);
    } finally {
      await held.release();
    }
  });

  test('stop() releases the port, and the next start can request it back', async () => {
    // Both halves of the remembered-port contract: the listener must actually
    // let go (a half-closed server would fail the rebind), and a port named in
    // config must be the one bound — the reason a restart does not rewrite the
    // operator's published Funnel.
    const first = await start();
    const port = first.teamPort!;
    await first.stop();
    expect(first.teamPort).toBeNull();
    const second = await start(port);
    expect(second.teamPort).toBe(port);
    expect(await reachable('127.0.0.1', port)).toBe(true);
  });

  test('an UNREADABLE config still settles start() — the wedge regression', async () => {
    // The original of this test guarded a throwing socket-path resolver. The
    // shape it protects is unchanged and is the reason it survives the rewrite:
    // anything thrown while preparing the team listener must degrade to "host
    // serving stays off", never leave start()'s promise unsettled — a daemon
    // that never finishes starting is strictly worse than one not hosting.
    fs.writeFileSync(path.join(tmp, 'myco.yaml'), ':\n  not: [valid', 'utf-8');
    const server = await start();
    // Settled — that is the assertion. Whether a port was claimed depends on
    // how far preparation got, and either outcome is acceptable.
    expect(server.teamPort === null || typeof server.teamPort === 'number').toBe(true);
  });
});
