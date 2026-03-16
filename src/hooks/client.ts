import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DAEMON_CLIENT_TIMEOUT_MS, DAEMON_HEALTH_CHECK_TIMEOUT_MS, DAEMON_HEALTH_RETRY_DELAYS } from '../constants.js';
import { AgentRegistry } from '../agents/registry.js';

interface DaemonInfo {
  pid: number;
  port: number;
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

      // Health checks use a shorter timeout than regular requests —
      // if the daemon doesn't respond in 500ms it's effectively down.
      const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
        signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const data = await res.json() as Record<string, unknown>;
      return data.myco === true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure the daemon is running. Spawns it if unhealthy and waits for it
   * to become ready. Returns true if the daemon is healthy after this call.
   */
  async ensureRunning(): Promise<boolean> {
    if (await this.isHealthy()) return true;

    this.spawnDaemon();

    for (const delay of DAEMON_HEALTH_RETRY_DELAYS) {
      await new Promise((r) => setTimeout(r, delay));
      if (await this.isHealthy()) return true;
    }
    return false;
  }

  spawnDaemon(): void {
    // Resolve daemon script via agent registry (checks all known agent env vars)
    // or fall back to relative path from this module.
    const pluginRoot = new AgentRegistry().resolvePluginRoot();
    const daemonScript = pluginRoot
      ? path.join(pluginRoot, 'dist', 'src', 'daemon', 'main.js')
      : path.resolve(import.meta.dirname, '..', 'daemon', 'main.js');
    if (!fs.existsSync(daemonScript)) return;

    const child = spawn('node', [daemonScript, '--vault', this.vaultDir], {
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
