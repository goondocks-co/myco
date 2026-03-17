import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DAEMON_CLIENT_TIMEOUT_MS, DAEMON_HEALTH_CHECK_TIMEOUT_MS, DAEMON_HEALTH_RETRY_DELAYS } from '../constants.js';
import { AgentRegistry } from '../agents/registry.js';
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
   */
  private async isStale(): Promise<boolean> {
    try {
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
   * Ensure the daemon is running the current version. Spawns it if unhealthy
   * or restarts it if the version is stale. Returns true if healthy after this call.
   */
  async ensureRunning(): Promise<boolean> {
    // Check if daemon is running but stale (version mismatch)
    if (await this.isStale()) {
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
    const daemonScript = this.resolveDaemonScript();
    if (!daemonScript || !fs.existsSync(daemonScript)) return;

    const child = spawn('node', [daemonScript, '--vault', this.vaultDir], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  /**
   * Resolve the daemon entry script path.
   * Priority:
   * 1. Plugin root env var (set by the agent host) → dist/src/daemon/main.js
   * 2. Walk up from the current file to find the dist/ directory containing
   *    the daemon entry. This handles both chunk files (dist/chunk-*.js) and
   *    thin entry points (dist/src/hooks/*.js) after bundling.
   */
  private resolveDaemonScript(): string | undefined {
    const pluginRoot = new AgentRegistry().resolvePluginRoot();
    if (pluginRoot) {
      return path.join(pluginRoot, 'dist', 'src', 'daemon', 'main.js');
    }

    // Walk up from import.meta.dirname looking for the daemon entry
    let dir = import.meta.dirname;
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'dist', 'src', 'daemon', 'main.js');
      if (fs.existsSync(candidate)) return candidate;
      // Also check if we're already inside dist/
      const inDist = path.join(dir, 'src', 'daemon', 'main.js');
      if (fs.existsSync(inDist)) return inDist;
      dir = path.dirname(dir);
    }
    return undefined;
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
