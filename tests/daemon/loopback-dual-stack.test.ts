import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DaemonServer } from '@myco/daemon/server.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { DaemonLogger } from '@myco/daemon/logger.js';

// The daemon must OWN its port on BOTH loopback stacks. Browsers commonly
// resolve `localhost` to `::1` before `127.0.0.1`, so a port bound only on
// IPv4 leaves its v6 side free for any process to claim and silently receive
// dashboard traffic addressed to the daemon (observed in the wild with a stray
// `ssh -L <port>:...` that lost the IPv4 bind and quietly kept `::1`). These
// tests are the gate on that property: if the companion listener ever stops
// binding, the squatter test below starts passing its bind and fails loudly.

function listenOnce(host: string, port: number): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err as NodeJS.ErrnoException));
    probe.listen(port, host, () => probe.close(() => resolve(null)));
  });
}

describe('daemon loopback dual-stack ownership', () => {
  let tmp: string;
  let logger: DaemonLogger;
  let server: DaemonServer;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-dual-stack-'));
    const vaultDir = path.join(tmp, '.myco');
    fs.mkdirSync(path.join(vaultDir, 'logs'), { recursive: true });
    logger = new DaemonLogger(path.join(vaultDir, 'logs'));
    server = new DaemonServer({
      vaultDir,
      logger,
      lockNamespace: testPerUserLockNamespace,
    });
  });

  afterEach(async () => {
    await server.stop();
    logger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('serves the same surface on [::1] as on 127.0.0.1', async () => {
    await server.start();
    const v4 = await fetch(`http://127.0.0.1:${server.port}/health`);
    const v6 = await fetch(`http://[::1]:${server.port}/health`);
    expect(v4.status).toBe(200);
    expect(v6.status).toBe(200);
    const v4Body = await v4.json() as { pid: number };
    const v6Body = await v6.json() as { pid: number };
    expect(v6Body.pid).toBe(v4Body.pid);
  });

  it('accepts a browser Origin of http://[::1]:<port> on the companion listener', async () => {
    await server.start();
    const res = await fetch(`http://[::1]:${server.port}/health`, {
      headers: { origin: `http://[::1]:${server.port}` },
    });
    expect(res.status).toBe(200);
  });

  it('holds the port on both stacks — a squatter bind fails with EADDRINUSE', async () => {
    await server.start();
    const v4Err = await listenOnce('127.0.0.1', server.port);
    const v6Err = await listenOnce('::1', server.port);
    expect(v4Err?.code).toBe('EADDRINUSE');
    expect(v6Err?.code).toBe('EADDRINUSE');
  });

  it('still starts on IPv4 when a squatter already holds [::1] on the port', async () => {
    // Reserve a port on IPv4, free it, then squat its v6 side — the exact
    // shape of the stray-tunnel incident, with the bind order reversed.
    const placeholder = net.createServer();
    const port = await new Promise<number>((resolve) => {
      placeholder.listen(0, '127.0.0.1', () => {
        resolve((placeholder.address() as net.AddressInfo).port);
      });
    });
    await new Promise<void>((resolve) => placeholder.close(() => resolve()));

    const squatter = net.createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(port, '::1', () => resolve());
    });
    try {
      await server.start(port);
      expect(server.port).toBe(port);
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it('releases both stacks on stop()', async () => {
    await server.start();
    const port = server.port;
    await server.stop();
    expect(await listenOnce('127.0.0.1', port)).toBeNull();
    expect(await listenOnce('::1', port)).toBeNull();
  });
});
