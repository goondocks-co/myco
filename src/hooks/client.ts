import fs from 'node:fs';
import path from 'node:path';

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
        signal: AbortSignal.timeout(5000),
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
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return { ok: false };
      const data = await res.json();
      return { ok: true, data };
    } catch {
      return { ok: false };
    }
  }

  async isHealthy(): Promise<boolean> {
    const result = await this.get('/health');
    return result.ok && result.data?.myco === true;
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
