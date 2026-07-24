import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  DaemonClient,
  type DaemonClientOptions,
  type RestartDeps,
} from '@myco/hooks/client';
import { ensureProjectManifest } from '@myco/config/project-manifest';
import { resolveServiceDaemonStatePath } from '@myco/grove/paths';
// Service-manager fake routes restart() through the legacy raw-spawn path so
// the stuck-detection logic — which is orthogonal to service management — is
// the only thing under test here.
import { noServiceManager } from '../helpers/fake-service-manager';

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
    const client = new DaemonClient(vaultDir, { serviceManager: noServiceManager() });

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const deps: RestartDeps = {
      isProcessAlive: () => true,   // would normally trigger escalation
      isPortBound: () => true,      // ditto
      kill: (pid, signal) => { killCalls.push({ pid, signal }); },
      stuckDetectionMs: 5,           // short to make sure we'd have escalated if unhealthy
      deadlineMs: 1_000,
      pollIntervalMs: 10,
    };

    // The supervisor publishes the successor state used by the health check.
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
    const client = new DaemonClient(vaultDir, { serviceManager: noServiceManager() });

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

  it('contains external MCP before every Windows termination and escalation', async () => {
    healthResponds = false;
    const lifecycle: string[] = [];
    const options = {
      serviceManager: noServiceManager(),
      platform: 'win32',
      cooperativeShutdown: async () => {
        lifecycle.push('cooperative');
        return { kind: 'unavailable' as const };
      },
      withExternalMcpContainment: async (terminate) => {
        lifecycle.push('contain');
        await terminate();
      },
      terminate: (_pid: number, signal: NodeJS.Signals) => {
        lifecycle.push(`terminate:${signal}`);
      },
    } satisfies DaemonClientOptions;
    const client = new DaemonClient(vaultDir, options);
    const deps: RestartDeps = {
      isProcessAlive: () => true,
      isPortBound: () => true,
      kill: (_pid, signal) => {
        lifecycle.push(`escalate:${signal}`);
        healthResponds = true;
        fs.writeFileSync(
          statePath,
          JSON.stringify({ pid: FAKE_PID + 1, port: healthPort }),
        );
      },
      stuckDetectionMs: 20,
      deadlineMs: 1_000,
      pollIntervalMs: 10,
    };

    await expect(client.restart({ checkStale: false }, deps)).resolves.toBe(true);

    expect(lifecycle).toEqual([
      'cooperative',
      'contain',
      'terminate:SIGTERM',
      'contain',
      'escalate:SIGKILL',
    ]);
  });

  it('refuses a Windows restart when external MCP containment fails', async () => {
    healthResponds = false;
    const lifecycle: string[] = [];
    const options = {
      serviceManager: noServiceManager(),
      platform: 'win32',
      cooperativeShutdown: async () => ({ kind: 'unavailable' as const }),
      withExternalMcpContainment: async () => {
        lifecycle.push('contain');
        throw new Error('containment failed');
      },
      terminate: (_pid: number, signal: NodeJS.Signals) => {
        lifecycle.push(`terminate:${signal}`);
      },
    } satisfies DaemonClientOptions;
    const client = new DaemonClient(vaultDir, options);

    await expect(client.restart({ checkStale: false }, {
      isProcessAlive: () => true,
      isPortBound: () => true,
      kill: (_pid, signal) => {
        lifecycle.push(`escalate:${signal}`);
      },
      stuckDetectionMs: 10,
      deadlineMs: 100,
      pollIntervalMs: 5,
    })).rejects.toThrow(/containment failed/);

    expect(lifecycle).toEqual(['contain']);
  });

  it('confirms external MCP containment after an older Windows daemon stops cooperatively', async () => {
    healthResponds = false;
    const lifecycle: string[] = [];
    const options = {
      serviceManager: noServiceManager(),
      platform: 'win32',
      cooperativeShutdown: async () => {
        lifecycle.push('cooperative');
        return { kind: 'stopped' as const };
      },
      withExternalMcpContainment: async (terminate) => {
        lifecycle.push('contain');
        await terminate();
        healthResponds = true;
        fs.writeFileSync(
          statePath,
          JSON.stringify({ pid: FAKE_PID + 1, port: healthPort }),
        );
      },
      terminate: (_pid: number, signal: NodeJS.Signals) => {
        lifecycle.push(`terminate:${signal}`);
      },
    } satisfies DaemonClientOptions;
    const client = new DaemonClient(vaultDir, options);

    await expect(client.restart({ checkStale: false }, {
      isProcessAlive: () => false,
      isPortBound: () => false,
      stuckDetectionMs: 20,
      deadlineMs: 500,
      pollIntervalMs: 10,
    })).resolves.toBe(true);

    expect(lifecycle).toEqual(['cooperative', 'contain']);
  });

  it('does not force-kill when the prev PID is already gone (waiting for supervisor)', async () => {
    // PID is dead; port is unbound. This is the "supervisor hasn't respawned
    // yet" state — escalating to SIGKILL would target a dead PID needlessly.
    healthResponds = false;
    const client = new DaemonClient(vaultDir, { serviceManager: noServiceManager() });

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
