import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { reconcileExistingDaemon } from '@myco/daemon/main';
import { DaemonLogger } from '@myco/daemon/logger';
import { getPluginVersion } from '@myco/version';

// Prevents the concurrent-spawn cascade we observed in production, where
// every newly-spawned daemon unconditionally SIGTERM'd whatever pid was in
// daemon.json — including siblings that had just become ready 300ms earlier.
// The contract: if a recorded daemon is recent AND healthy AND running the
// same version, step aside. Otherwise (absent, dead, unhealthy, or mismatched
// version) take over.

function makeLogger(vaultDir: string): DaemonLogger {
  return new DaemonLogger(path.join(vaultDir, 'logs'), { level: 'info' });
}

async function withHealthServer<T>(
  response: { status: number; body: unknown },
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const server = http.createServer((_req, res) => {
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('reconcileExistingDaemon', () => {
  let vaultDir: string;
  let sibling: ChildProcess;
  let siblingPid: number;

  beforeEach(async () => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-reconcile-'));
    // Real sibling process so info.pid !== process.pid (self-protection guard
    // in reconcile would otherwise early-return 'ok'). The child does nothing
    // but stay alive; we tear it down after each case.
    sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},60000)'], {
      stdio: 'ignore',
    });
    await new Promise<void>((resolve) => sibling.once('spawn', () => resolve()));
    if (!sibling.pid) throw new Error('sibling failed to spawn');
    siblingPid = sibling.pid;
  });

  afterEach(async () => {
    sibling.kill('SIGKILL');
    await new Promise<void>((resolve) => sibling.once('exit', () => resolve()));
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('returns ok when daemon.json is absent', async () => {
    const result = await reconcileExistingDaemon(vaultDir, makeLogger(vaultDir));
    expect(result).toBe('ok');
  });

  it('returns ok and cleans daemon.json when recorded pid is dead', async () => {
    fs.writeFileSync(
      path.join(vaultDir, 'daemon.json'),
      JSON.stringify({ pid: 0x7fffffff, port: 12345 }),
    );
    const result = await reconcileExistingDaemon(vaultDir, makeLogger(vaultDir));
    expect(result).toBe('ok');
    expect(fs.existsSync(path.join(vaultDir, 'daemon.json'))).toBe(false);
  });

  it('steps aside when recorded daemon is recent, healthy, and same version', async () => {
    await withHealthServer(
      { status: 200, body: { myco: true, version: getPluginVersion() } },
      async (port) => {
        fs.writeFileSync(
          path.join(vaultDir, 'daemon.json'),
          JSON.stringify({ pid: siblingPid, port }),
        );
        const result = await reconcileExistingDaemon(vaultDir, makeLogger(vaultDir));
        expect(result).toBe('step-aside');
        // daemon.json must survive — the sibling we stepped aside for owns it.
        expect(fs.existsSync(path.join(vaultDir, 'daemon.json'))).toBe(true);
      },
    );
  });

  it('takes over (ok) when recorded daemon version differs from the current plugin', async () => {
    await withHealthServer(
      { status: 200, body: { myco: true, version: '0.0.0-different' } },
      async (port) => {
        fs.writeFileSync(
          path.join(vaultDir, 'daemon.json'),
          JSON.stringify({ pid: siblingPid, port }),
        );
        const result = await reconcileExistingDaemon(vaultDir, makeLogger(vaultDir));
        expect(result).toBe('ok');
        expect(fs.existsSync(path.join(vaultDir, 'daemon.json'))).toBe(false);
      },
    );
  });

  it('steps aside when daemon is healthy but command differs (runtime mismatch)', async () => {
    await withHealthServer(
      { status: 200, body: { myco: true, version: '0.0.0-different' } },
      async (port) => {
        fs.writeFileSync(
          path.join(vaultDir, 'daemon.json'),
          JSON.stringify({ pid: siblingPid, port, command: '/tmp/bun-myco' }),
        );
        const result = await reconcileExistingDaemon(vaultDir, makeLogger(vaultDir));
        expect(result).toBe('step-aside');
        expect(fs.existsSync(path.join(vaultDir, 'daemon.json'))).toBe(true);
      },
    );
  });

  it('takes over (ok) when daemon.json is older than the grace window', async () => {
    await withHealthServer(
      { status: 200, body: { myco: true, version: getPluginVersion() } },
      async (port) => {
        const jsonPath = path.join(vaultDir, 'daemon.json');
        fs.writeFileSync(jsonPath, JSON.stringify({ pid: siblingPid, port }));
        // Backdate mtime well past DAEMON_STALE_GRACE_PERIOD_MS (60s).
        const ancient = (Date.now() - 10 * 60 * 1000) / 1000;
        fs.utimesSync(jsonPath, ancient, ancient);
        const result = await reconcileExistingDaemon(vaultDir, makeLogger(vaultDir));
        expect(result).toBe('ok');
        expect(fs.existsSync(jsonPath)).toBe(false);
      },
    );
  });

  it('takes over (ok) when recorded daemon fails its health probe', async () => {
    // Port 1 is privileged and refuses user-space fetches — the health probe
    // times out / fails, and we should fall through to takeover.
    fs.writeFileSync(
      path.join(vaultDir, 'daemon.json'),
      JSON.stringify({ pid: siblingPid, port: 1 }),
    );
    const result = await reconcileExistingDaemon(vaultDir, makeLogger(vaultDir));
    expect(result).toBe('ok');
    expect(fs.existsSync(path.join(vaultDir, 'daemon.json'))).toBe(false);
  });
});
