import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DAEMON_CLIENT_TIMEOUT_MS, DAEMON_HEALTH_CHECK_TIMEOUT_MS, DAEMON_HEALTH_RETRY_DELAYS, DAEMON_STALE_GRACE_PERIOD_MS } from '../constants.js';
import { getPluginVersion } from '../version.js';

interface DaemonInfo {
  pid: number;
  port: number;
}

interface HealthResponse {
  myco: boolean;
  version?: string;
}

interface ClientResult {
  ok: boolean;
  data?: any;
}

export class DaemonClient {
  private vaultDir: string;

  constructor(vaultDir: string) {
    this.vaultDir = vaultDir;
  }

  async post(endpoint: string, body: unknown): Promise<ClientResult> {
    try {
      const info = this.readDaemonJson();
      if (!info) return { ok: false };

      const res = await fetch(`http://127.0.0.1:${info.port}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DAEMON_CLIENT_TIMEOUT_MS),
      });

      if (!res.ok) return { ok: false };
      const data = await res.json();
      return { ok: true, data };
    } catch {
      return { ok: false };
    }
  }

  async get(endpoint: string): Promise<ClientResult> {
    try {
      const info = this.readDaemonJson();
      if (!info) return { ok: false };

      const res = await fetch(`http://127.0.0.1:${info.port}${endpoint}`, {
        signal: AbortSignal.timeout(DAEMON_CLIENT_TIMEOUT_MS),
      });

      if (!res.ok) return { ok: false };
      const data = await res.json();
      return { ok: true, data };
    } catch {
      return { ok: false };
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const info = this.readDaemonJson();
      if (!info) return false;

      const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
        signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const data = await res.json() as HealthResponse;
      return data.myco === true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the daemon is running a stale version.
   * Returns true if the daemon's version doesn't match the current plugin version.
   * Skips the check if daemon.json was written recently (grace period) to prevent
   * rapid restart loops from concurrent hooks or session reloads.
   */
  private async isStale(): Promise<boolean> {
    try {
      const jsonPath = path.join(this.vaultDir, 'daemon.json');
      const stat = fs.statSync(jsonPath);
      if (Date.now() - stat.mtimeMs < DAEMON_STALE_GRACE_PERIOD_MS) {
        return false;
      }

      const info = this.readDaemonJson();
      if (!info) return false;

      const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
        signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const data = await res.json() as HealthResponse;
      if (!data.myco) return false;

      // No version in response = old daemon that predates this check
      if (!data.version) return true;

      return data.version !== getPluginVersion();
    } catch {
      return false;
    }
  }

  /**
   * Kill the running daemon process.
   */
  private killDaemon(): void {
    try {
      const info = this.readDaemonJson();
      if (!info) return;
      process.kill(info.pid, 'SIGTERM');
    } catch { /* already dead */ }
    try {
      fs.unlinkSync(path.join(this.vaultDir, 'daemon.json'));
    } catch { /* already gone */ }
  }

  /**
   * Ensure the daemon is running. Spawns it if unhealthy.
   * When checkStale is true (default), also restarts a healthy daemon if its
   * version doesn't match the current plugin version. Use checkStale: false
   * for hooks that just need the daemon alive (e.g., stop) without triggering
   * version-driven restarts.
   */
  async ensureRunning(opts?: { checkStale?: boolean }): Promise<boolean> {
    const checkStale = opts?.checkStale ?? true;

    if (checkStale && await this.isStale()) {
      this.killDaemon();
      // Brief pause for port release
      await new Promise((r) => setTimeout(r, 200));
    } else if (await this.isHealthy()) {
      return true;
    }

    this.spawnDaemon();

    for (const delay of DAEMON_HEALTH_RETRY_DELAYS) {
      await new Promise((r) => setTimeout(r, delay));
      if (await this.isHealthy()) return true;
    }
    return false;
  }

  spawnDaemon(): void {
    const mycoCmd = process.env.MYCO_CMD || 'myco';
    const child = spawn(mycoCmd, ['daemon', '--vault', this.vaultDir], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  private readDaemonJson(): DaemonInfo | null {
    try {
      const jsonPath = path.join(this.vaultDir, 'daemon.json');
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const info = JSON.parse(content);
      if (typeof info.port !== 'number') return null;
      return info as DaemonInfo;
    } catch {
      return null;
    }
  }
}
