import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DaemonClient, type RestartDeps } from '@myco/hooks/client';
import { ensureProjectManifest } from '@myco/config/project-manifest';
import { resolveServiceDaemonStatePath } from '@myco/grove/paths';
import type { ServiceManager, ServiceSpec, ServiceStatus } from '@myco/service/types';

/** Service manager that reports "no daemon service installed" so restart() falls
 *  through to the legacy raw-spawn path. The stuck-detection logic is
 *  orthogonal to service-management: it triggers whenever /health is silent
 *  but the prev PID is still alive and bound to the port. */
class NoServiceManager implements ServiceManager {
  readonly supported = true;
  readonly platformName = 'fake (no service)';
  async isInstalled(_label: string): Promise<boolean> { return false; }
  async install(_spec: ServiceSpec): Promise<void> {}
  async uninstall(_label: string): Promise<void> {}
  async start(_label: string): Promise<void> {}
  async stop(_label: string): Promise<void> {}
  async restart(_label: string): Promise<void> {}
  restartShellCommand(_label: string): string { return ''; }
  async status(_label: string): Promise<ServiceStatus> {
    return { installed: false, running: false, pid: null, lastExitCode: null, unitPath: null };
  }
}

/** A PID we can safely "track" without ever touching a real process. The
 *  injected isProcessAlive / isPortBound deps decide whether the test daemon
 *  is alive — actual kernel calls never see this PID. */
const FAKE_PID = 999_999_999;
const FAKE_PORT = 65_535;

describe('DaemonClient.restart — stuck-shutdown recovery', () => {
  let vaultDir: string;
  let statePath: string;
  let healthServer: http.Server | null;
  let healthPort: number;
  let healthResponds: boolean;

  beforeEach(async () => {
    // Suppress the fire-and-forget spawnDaemon side effect that restart's
    // ensureRunning path would trigger. The stuck-detection loop is what we
    // exercise here, not the spawn child.
    process.env.MYCO_NO_AUTO_SPAWN = '1';

    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-restart-stuck-'));
    ensureProjectManifest(vaultDir, { projectName: 'restart-stuck-test' });
    statePath = resolveServiceDaemonStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });

    healthResponds = false;
    healthServer = http.createServer((req, res) => {
      if (req.url === '/health' && healthResponds) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ myco: true }));
      } else {
        // Either /health is "hung" (no response) or a non-health request.
        // Closing immediately mimics the daemon refusing to serve.
        res.destroy();
      }
    });

    await new Promise<void>((resolve) => {
      healthServer!.listen(0, '127.0.0.1', () => {
        healthPort = (healthServer!.address() as { port: number }).port;
        // daemon.json points at the local health server. The prev pid is a
        // synthetic value — killDaemon's real process.kill will throw and be
        // swallowed; only the injected `kill` dep observes SIGKILL escalation.
        fs.writeFileSync(
          statePath,
          JSON.stringify({ pid: FAKE_PID, port: healthPort }),
        );
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (healthServer) {
      await new Promise<void>((r) => healthServer!.close(() => r()));
      healthServer = null;
    }
    try { fs.unlinkSync(statePath); } catch { /* gone */ }
    fs.rmSync(vaultDir, { recursive: true, force: true });
    delete process.env.MYCO_NO_AUTO_SPAWN;
  });

  it('returns true without force-killing when /health responds promptly', async () => {
    healthResponds = true;
    // Re-publish daemon.json after killDaemon clears it during the call — we
    // simulate the supervisor respawning a healthy daemon at the same port.
    const client = new DaemonClient(vaultDir, { serviceManager: new NoServiceManager() });

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const deps: RestartDeps = {
      isProcessAlive: () => true,   // would normally trigger escalation
      isPortBound: () => true,      // ditto
      kill: (pid, signal) => { killCalls.push({ pid, signal }); },
      stuckDetectionMs: 5,           // short to make sure we'd have escalated if unhealthy
      deadlineMs: 1_000,
      pollIntervalMs: 10,
    };

    // killDaemon clears daemon.json before our poll loop runs — reinstate it
    // so isHealthy can resolve the port. In production launchd writes a fresh
    // daemon.json when it respawns.
    setTimeout(() => {
      fs.writeFileSync(statePath, JSON.stringify({ pid: FAKE_PID, port: healthPort }));
    }, 5);

    const ok = await client.restart({ checkStale: false }, deps);
    expect(ok).toBe(true);
    expect(killCalls).toHaveLength(0); // no SIGKILL escalation for a healthy restart
  });

  it('force-kills the prev PID when /health hangs and listener is still bound', async () => {
    // Health server never returns 200 until after we observe a force-kill —
    // models the wedge: prev daemon owns the port, /health silent.
    healthResponds = false;
    const client = new DaemonClient(vaultDir, { serviceManager: new NoServiceManager() });

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const deps: RestartDeps = {
      isProcessAlive: () => true,
      isPortBound: (port, pid) => port === healthPort && pid === FAKE_PID,
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
        // Mimic launchd's KeepAlive: shortly after SIGKILL, a fresh daemon
        // comes up healthy at the same port.
        setTimeout(() => {
          healthResponds = true;
          fs.writeFileSync(
            statePath,
            JSON.stringify({ pid: FAKE_PID + 1, port: healthPort }),
          );
        }, 20);
      },
      stuckDetectionMs: 30,
      deadlineMs: 2_000,
      pollIntervalMs: 15,
    };

    const ok = await client.restart({ checkStale: false }, deps);
    expect(ok).toBe(true);
    expect(killCalls).toHaveLength(1);
    expect(killCalls[0]!.pid).toBe(FAKE_PID);
    expect(killCalls[0]!.signal).toBe('SIGKILL');
  });

  it('does not force-kill when the prev PID is already gone (waiting for supervisor)', async () => {
    // PID is dead; port is unbound. This is the "supervisor hasn't respawned
    // yet" state — escalating to SIGKILL would target a dead PID needlessly.
    healthResponds = false;
    const client = new DaemonClient(vaultDir, { serviceManager: new NoServiceManager() });

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const deps: RestartDeps = {
      isProcessAlive: () => false,
      isPortBound: () => false,
      kill: (pid, signal) => { killCalls.push({ pid, signal }); },
      stuckDetectionMs: 20,
      // Tight deadline so we don't actually wait 30s for the loop to exit.
      deadlineMs: 200,
      pollIntervalMs: 15,
    };

    const ok = await client.restart({ checkStale: false }, deps);
    expect(ok).toBe(false); // never became healthy in test window
    expect(killCalls).toHaveLength(0); // no unnecessary SIGKILL of a dead PID
  });
});
