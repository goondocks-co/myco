import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { reconcileExistingDaemon, isHealthyMycoSibling } from '@myco/daemon/main';
import { DaemonLogger } from '@myco/daemon/logger';
import { getPluginVersion } from '@myco/version';
import type { DaemonServiceState } from '@myco/daemon/service-state';

// Prevents the concurrent-spawn cascade we observed in production, where
// every newly-spawned daemon unconditionally SIGTERM'd whatever pid was in
// daemon.json — including siblings that had just become ready 300ms earlier.
// The contract: if a recorded daemon is recent AND healthy AND running the
// same version, step aside. Otherwise (absent, dead, unhealthy, or mismatched
// version) take over.

function makeLogger(vaultDir: string): DaemonLogger {
  return new DaemonLogger(path.join(vaultDir, 'logs'), { level: 'info' });
}

function daemonService(vaultDir: string, overrides: Partial<DaemonServiceState> = {}): DaemonServiceState {
  const stateDir = path.join(vaultDir, 'service');
  return {
    scope: 'global',
    stateDir,
    statePath: path.join(stateDir, 'daemon.json'),
    canonicalPort: 0,
    ...overrides,
  };
}

function adjacentPort(port: number): number {
  return port === 65_535 ? port - 1 : port + 1;
}

async function withHealthServer<T>(
  response: { status: number; body: unknown },
  fn: (port: number) => Promise<T>,
  port = 0,
): Promise<T> {
  const server = http.createServer((_req, res) => {
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  const boundPort = (server.address() as { port: number }).port;
  try {
    return await fn(boundPort);
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
    try { fs.unlinkSync(daemonService(vaultDir).statePath); } catch { /* gone */ }
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('returns ok when daemon.json is absent', async () => {
    const result = await reconcileExistingDaemon(daemonService(vaultDir), makeLogger(vaultDir));
    expect(result).toBe('ok');
  });

  it('returns ok and cleans daemon.json when recorded pid is dead', async () => {
    const svc = daemonService(vaultDir);
    fs.mkdirSync(path.dirname(svc.statePath), { recursive: true });
    fs.writeFileSync(
      svc.statePath,
      JSON.stringify({ pid: 0x7fffffff, port: 12345 }),
    );
    const result = await reconcileExistingDaemon(svc, makeLogger(vaultDir));
    expect(result).toBe('ok');
    expect(fs.existsSync(svc.statePath)).toBe(false);
  });

  it('steps aside when recorded daemon is recent, healthy, same version, and on canonical port', async () => {
    await withHealthServer(
      { status: 200, body: { myco: true, version: getPluginVersion() } },
      async (port) => {
        const svc = daemonService(vaultDir, { canonicalPort: port });
        fs.mkdirSync(path.dirname(svc.statePath), { recursive: true });
        fs.writeFileSync(
          svc.statePath,
          JSON.stringify({ pid: siblingPid, port }),
        );
        const result = await reconcileExistingDaemon(svc, makeLogger(vaultDir));
        expect(result).toBe('step-aside');
        // daemon.json must survive — the sibling we stepped aside for owns it.
        expect(fs.existsSync(svc.statePath)).toBe(true);
      },
    );
  });

  it('takes over (ok) when recorded daemon is healthy but NOT on the canonical port', async () => {
    // An orphan squatting the canonical port forced the sibling to fall back
    // to a non-canonical port. We must NOT step aside — we need to proceed
    // through eviction so the canonical port is reclaimed.
    await withHealthServer(
      { status: 200, body: { myco: true, version: getPluginVersion() } },
      async (port) => {
        const svc = daemonService(vaultDir, { canonicalPort: adjacentPort(port) });
        fs.mkdirSync(path.dirname(svc.statePath), { recursive: true });
        fs.writeFileSync(
          svc.statePath,
          JSON.stringify({ pid: siblingPid, port }),
        );
        const result = await reconcileExistingDaemon(svc, makeLogger(vaultDir));
        expect(result).toBe('ok');
      },
      // Explicitly NOT the canonical port — let the OS pick any ephemeral port.
      0,
    );
  });

  it('takes over (ok) when recorded daemon version differs from the current plugin', async () => {
    await withHealthServer(
      { status: 200, body: { myco: true, version: '0.0.0-different' } },
      async (port) => {
        const svc = daemonService(vaultDir, { canonicalPort: port });
        fs.mkdirSync(path.dirname(svc.statePath), { recursive: true });
        fs.writeFileSync(
          svc.statePath,
          JSON.stringify({ pid: siblingPid, port }),
        );
        const result = await reconcileExistingDaemon(svc, makeLogger(vaultDir));
        expect(result).toBe('ok');
        expect(fs.existsSync(svc.statePath)).toBe(false);
      },
    );
  });

  it('steps aside when daemon is healthy but command differs (runtime mismatch)', async () => {
    await withHealthServer(
      { status: 200, body: { myco: true, version: '0.0.0-different' } },
      async (port) => {
        const svc = daemonService(vaultDir, { canonicalPort: port });
        fs.mkdirSync(path.dirname(svc.statePath), { recursive: true });
        fs.writeFileSync(
          svc.statePath,
          JSON.stringify({ pid: siblingPid, port, command: '/tmp/bun-myco' }),
        );
        const result = await reconcileExistingDaemon(svc, makeLogger(vaultDir));
        expect(result).toBe('step-aside');
        expect(fs.existsSync(svc.statePath)).toBe(true);
      },
    );
  });

  it('takes over (ok) when daemon.json is older than the grace window', async () => {
    await withHealthServer(
      { status: 200, body: { myco: true, version: getPluginVersion() } },
      async (port) => {
        const svc = daemonService(vaultDir, { canonicalPort: port });
        fs.mkdirSync(path.dirname(svc.statePath), { recursive: true });
        fs.writeFileSync(svc.statePath, JSON.stringify({ pid: siblingPid, port }));
        // Backdate mtime well past DAEMON_STALE_GRACE_PERIOD_MS (60s).
        const ancient = (Date.now() - 10 * 60 * 1000) / 1000;
        fs.utimesSync(svc.statePath, ancient, ancient);
        const result = await reconcileExistingDaemon(svc, makeLogger(vaultDir));
        expect(result).toBe('ok');
        expect(fs.existsSync(svc.statePath)).toBe(false);
      },
    );
  });

  it('takes over (ok) when recorded daemon fails its health probe', async () => {
    // Port 1 is privileged and refuses user-space fetches — the health probe
    // times out / fails, and we should fall through to takeover.
    const svc = daemonService(vaultDir);
    fs.mkdirSync(path.dirname(svc.statePath), { recursive: true });
    fs.writeFileSync(
      svc.statePath,
      JSON.stringify({ pid: siblingPid, port: 1 }),
    );
    const result = await reconcileExistingDaemon(svc, makeLogger(vaultDir));
    expect(result).toBe('ok');
    expect(fs.existsSync(svc.statePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isHealthyMycoSibling — late-race detector
// ---------------------------------------------------------------------------

describe('isHealthyMycoSibling', () => {
  it('returns true when the port answers /health with myco:true', async () => {
    await withHealthServer(
      { status: 200, body: { myco: true, version: '1.0.0' } },
      async (port) => {
        expect(await isHealthyMycoSibling(port)).toBe(true);
      },
    );
  });

  it('returns false when /health is non-2xx', async () => {
    await withHealthServer(
      { status: 500, body: { error: 'boom' } },
      async (port) => {
        expect(await isHealthyMycoSibling(port)).toBe(false);
      },
    );
  });

  it('returns false when /health responds without myco:true', async () => {
    await withHealthServer(
      { status: 200, body: { some: 'other service' } },
      async (port) => {
        expect(await isHealthyMycoSibling(port)).toBe(false);
      },
    );
  });

  it('returns false when the port is not listening', async () => {
    // Port 1 refuses connections under normal userspace permissions.
    expect(await isHealthyMycoSibling(1)).toBe(false);
  });
});
