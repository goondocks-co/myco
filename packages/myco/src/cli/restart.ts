import { evictDaemonsForVault } from '../daemon/eviction.js';
import fs from 'node:fs';
import path from 'node:path';

export async function run(_args: string[], vaultDir: string): Promise<void> {
  // Evict every daemon for this vault — handles both the PID in daemon.json
  // and orphans holding the canonical port without JSON registration. Waits
  // for SIGTERM → (optional SIGKILL) → process exit before returning so the
  // subsequent spawn can bind the canonical port cleanly.
  const evicted = await evictDaemonsForVault(vaultDir, {
    logger: {
      info: (_kind, msg, meta) => console.log(formatLog(msg, meta)),
      warn: (_kind, msg, meta) => console.warn(formatLog(msg, meta)),
    },
  });
  if (evicted.length > 0) {
    console.log(`Stopped ${evicted.length} daemon(s): ${evicted.map((e) => e.pid).join(', ')}`);
  } else {
    console.log('No existing daemon to stop');
  }

  const { DaemonClient } = await import('../hooks/client.js');
  const client = new DaemonClient(vaultDir);

  console.log('Waiting for health check...');
  const healthy = await client.ensureRunning();
  if (!healthy) {
    console.error('Daemon failed to become healthy');
    return;
  }

  const daemonPath = path.join(vaultDir, 'daemon.json');
  try {
    const info = JSON.parse(fs.readFileSync(daemonPath, 'utf-8'));
    console.log(`Daemon healthy on port ${info.port}`);
    console.log(`Dashboard: http://localhost:${info.port}/`);
  } catch {
    console.log('Daemon healthy');
  }
}

function formatLog(message: string, meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return message;
  return `${message} ${JSON.stringify(meta)}`;
}
