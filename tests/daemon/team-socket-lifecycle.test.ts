/**
 * The Team Host listener's socket lifecycle.
 *
 * The socket is what replaced the Host-header allowlist: containment is now a
 * filesystem permission rather than a string comparison, and the docstring on
 * `startTeamListener` makes specific claims about reclaim, ownership, and
 * teardown. Those claims are the whole containment story on a surface that will
 * be published to the internet, so they are asserted here rather than trusted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { teamSocketPath, removeSocket } from '../helpers/team-socket.js';

const HOST_BEARER = 'team-socket-lifecycle-bearer';

const stubAuthority = {
  read: () => null,
  write: () => {},
  clear: () => {},
} as unknown as ConstructorParameters<typeof DaemonServer>[0]['daemonStateAuthority'];

describe('team listener socket lifecycle', () => {
  let tmp: string;
  let servers: DaemonServer[];
  let socks: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-sock-life-'));
    servers = [];
    socks = [];
  });

  afterEach(async () => {
    for (const s of servers) await s.stop().catch(() => {});
    for (const s of socks) removeSocket(s);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function start(socketPath: string, opts: { serving?: boolean } = {}): Promise<DaemonServer> {
    const server = new DaemonServer({
      vaultDir: path.join(tmp, `vault-${servers.length}`),
      logger: new DaemonLogger(path.join(tmp, `logs-${servers.length}`)),
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
      ...(opts.serving === false ? {} : { hostServe: { bearer: HOST_BEARER } }),
      teamSocketPath: socketPath,
    });
    servers.push(server);
    socks.push(socketPath);
    await server.start(0);
    return server;
  }

  test('binds the socket, and locks the socket and its directory to this user', async () => {
    const sock = teamSocketPath('modes');
    const server = await start(sock);

    expect(server.teamSocketPath).toBe(sock);
    expect(fs.existsSync(sock)).toBe(true);
    // The directory is the containment boundary — group/world bits here would
    // let another local account reach a surface that has no Host check left.
    expect(fs.lstatSync(path.dirname(sock)).mode & 0o077).toBe(0);
    expect(fs.lstatSync(sock).mode & 0o077).toBe(0);
  });

  test('reclaims a STALE socket path — a leftover file never blocks a restart', async () => {
    const sock = teamSocketPath('stale');
    fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
    // A plain file at the path is what a SIGKILLed daemon leaves behind: bind()
    // reports EADDRINUSE for it even though nothing is listening.
    fs.writeFileSync(sock, '');

    const server = await start(sock);
    expect(server.teamSocketPath).toBe(sock);
    expect(fs.existsSync(sock)).toBe(true);
  });

  // NOTE: this is sequential, so it also passed under the old probe-then-unlink
  // code. It pins the outcome, not the TOCTOU fix — two daemons racing from a
  // clean path has no deterministic test here and is knowingly ungated.
  test('refuses a LIVE socket — a second daemon never steals the first one listener', async () => {
    const sock = teamSocketPath('live');
    const first = await start(sock);
    expect(first.teamSocketPath).toBe(sock);

    // Same socket path, second daemon: the bind loses, and losing must mean
    // "stay off", not "unlink the winner and take it".
    const second = await start(sock);
    expect(second.teamSocketPath).toBeNull();

    // The winner is still serving on a socket that still exists.
    expect(first.teamSocketPath).toBe(sock);
    expect(fs.existsSync(sock)).toBe(true);
    await new Promise<void>((resolve, reject) => {
      const probe = net.connect(sock);
      probe.once('connect', () => { probe.destroy(); resolve(); });
      probe.once('error', reject);
    });
  });

  test('stop() unlinks the socket, so the next start binds cleanly', async () => {
    const sock = teamSocketPath('teardown');
    const server = await start(sock);
    expect(fs.existsSync(sock)).toBe(true);

    await server.stop();
    expect(fs.existsSync(sock)).toBe(false);
    expect(server.teamSocketPath).toBeNull();
  });

  test('host serving off → no socket is bound at all', async () => {
    const sock = teamSocketPath('off');
    const server = await start(sock, { serving: false });
    expect(server.teamSocketPath).toBeNull();
    expect(fs.existsSync(sock)).toBe(false);
  });

  test('refuses a socket directory that is a symlink — the planted-path attack', async () => {
    // `mkdirSync(recursive)` accepts a pre-existing symlink silently, and
    // `chmod` follows it: without an lstat check the daemon would happily serve
    // its team surface out of a directory another local account controls.
    const sock = teamSocketPath('symlink');
    const real = fs.mkdtempSync(path.join(tmp, 'planted-'));
    fs.mkdirSync(path.dirname(path.dirname(sock)), { recursive: true });
    fs.symlinkSync(real, path.dirname(sock));

    try {
      const server = await start(sock);
      expect(server.teamSocketPath).toBeNull();
      expect(fs.existsSync(sock)).toBe(false);
      // The uid branch of the same check needs a second user and stays untested.
    } finally {
      fs.rmSync(path.dirname(sock), { force: true });
    }
  });

  test('a THROWING resolveTeamSocketPath still settles start() — the actual regression', async () => {
    // The sibling below passes a `teamSocketPath` override, and `??` short-
    // circuits, so it never calls `resolveTeamSocketPath` at all — it exercises
    // a directory-preparation failure instead. This one omits the override so
    // resolution really runs, and makes it throw the only way it can: both the
    // HOME-anchored path and the tmpdir fallback over the 104-byte sun_path cap,
    // which the resolver refuses before any syscall.
    //
    // That throw used to escape the listener's promise executor, leaving
    // `start()` unsettled and the daemon never finishing startup — silently.
    const longHome = path.join(tmp, 'h'.repeat(120));
    const longTmp = path.join(tmp, 't'.repeat(120));
    fs.mkdirSync(longHome, { recursive: true });
    fs.mkdirSync(longTmp, { recursive: true });
    const prevHome = process.env.HOME;
    const prevTmp = process.env.TMPDIR;
    process.env.HOME = longHome;
    process.env.TMPDIR = longTmp;

    try {
      const server = new DaemonServer({
        vaultDir: path.join(tmp, 'vault-resolve'),
        logger: new DaemonLogger(path.join(tmp, 'logs-resolve')),
        daemonStateAuthority: stubAuthority,
        lockNamespace: testPerUserLockNamespace,
        hostServe: { bearer: HOST_BEARER },
        // NO teamSocketPath — resolution must actually run.
      });
      servers.push(server);

      await Promise.race([
        server.start(0),
        new Promise((_, reject) => setTimeout(() => reject(new Error('start() hung')), 5_000)),
      ]);

      expect(server.teamSocketPath).toBeNull();
      expect(server.port).toBeGreaterThan(0);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevTmp;
    }
  });

  test('an unresolvable socket path leaves the daemon UP with serving off — never a hung start()', async () => {
    // The degraded outcome is the contract: resolution can throw (no
    // short-enough AF_UNIX path, EACCES walking the home). A throw escaping the
    // listener leaves start()'s promise chain unsettled, so the daemon never
    // finishes starting at all — strictly worse than not serving.
    const blocker = path.join(tmp, 'not-a-directory');
    fs.writeFileSync(blocker, '');

    const server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault-throw'),
      logger: new DaemonLogger(path.join(tmp, 'logs-throw')),
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
      hostServe: { bearer: HOST_BEARER },
      // Parent is a regular FILE, so mkdir fails ENOTDIR — a deterministic
      // preparation failure. (An over-long path is NOT a reliable trigger: it
      // binds fine here, so testing the sun_path cap this way would assert
      // nothing.)
      teamSocketPath: path.join(blocker, 'team.sock'),
    });
    servers.push(server);

    await Promise.race([
      server.start(0),
      new Promise((_, reject) => setTimeout(() => reject(new Error('start() hung')), 5_000)),
    ]);

    expect(server.teamSocketPath).toBeNull();
    // The loopback listener is up regardless — that is the "degraded, not down"
    // property this test exists to hold.
    expect(server.port).toBeGreaterThan(0);
  });
});
