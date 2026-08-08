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
import { teamTestPort } from '../helpers/team-socket.js';

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

  test('binds the requested loopback port and reports it', async () => {
    const port = teamTestPort();
    const server = await start(port);
    expect(server.teamPort).toBe(port);
    expect(await reachable('127.0.0.1', port)).toBe(true);
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

  test('host serving OFF binds nothing at all', async () => {
    const server = await start(undefined, { serving: false });
    expect(server.teamPort).toBeNull();
  });

  test('stop() releases the port so the next start can take it', async () => {
    const port = teamTestPort();
    const first = await start(port);
    expect(first.teamPort).toBe(port);
    await first.stop();
    expect(first.teamPort).toBeNull();
    // The same port binds again — proof the listener actually let go, which a
    // half-closed server would fail.
    const second = await start(port);
    expect(second.teamPort).toBe(port);
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
