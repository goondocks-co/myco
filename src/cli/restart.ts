import { isProcessAlive } from './shared.js';
import fs from 'node:fs';
import path from 'node:path';

export async function run(_args: string[], vaultDir: string): Promise<void> {
  const daemonPath = path.join(vaultDir, 'daemon.json');

  // Kill existing daemon if running
  if (fs.existsSync(daemonPath)) {
    try {
      const daemon = JSON.parse(fs.readFileSync(daemonPath, 'utf-8'));
      if (isProcessAlive(daemon.pid)) {
        process.kill(daemon.pid, 'SIGTERM');
        console.log(`Stopped daemon (pid ${daemon.pid})`);
      } else {
        console.log(`Daemon pid ${daemon.pid} was already dead`);
      }
    } catch { /* ignore */ }
    try { fs.unlinkSync(daemonPath); } catch { /* already gone */ }
  }

  // Spawn and wait for health using the shared client
  // (handles CLAUDE_PLUGIN_ROOT + CURSOR_PLUGIN_ROOT resolution)
  const { DaemonClient } = await import('../hooks/client.js');
  const client = new DaemonClient(vaultDir);

  console.log('Waiting for health check...');
  const healthy = await client.ensureRunning();
  if (healthy) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonPath, 'utf-8'));
      console.log(`Daemon healthy on port ${info.port}`);
      console.log(`Dashboard: http://localhost:${info.port}/ui/`);
    } catch {
      console.log('Daemon healthy');
    }
  } else {
    console.error('Daemon failed to become healthy');
  }
}
