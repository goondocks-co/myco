import { DaemonClient } from './client.js';
import { readStdin } from './read-stdin.js';
import { loadConfig } from '../config/loader.js';
import { MycoIndex } from '../index/sqlite.js';
import { buildInjectedContext } from '../context/injector.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const config = loadConfig(VAULT_DIR);
    const client = new DaemonClient(VAULT_DIR);

    if (!(await client.isHealthy())) {
      spawnDaemon(VAULT_DIR);
      // Wait for daemon to become healthy (up to 3s with backoff)
      let healthy = false;
      for (const delay of [100, 200, 400, 800, 1500]) {
        await new Promise((r) => setTimeout(r, delay));
        if (await client.isHealthy()) { healthy = true; break; }
      }
      if (!healthy) {
        // Daemon didn't start — fall through to degraded mode
      }
    }

    const input = JSON.parse(await readStdin());
    const sessionId = input.session_id ?? `s-${Date.now()}`;

    let branch: string | undefined;
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
    } catch { /* not a git repo */ }

    await client.post('/sessions/register', {
      session_id: sessionId,
      branch,
      started_at: new Date().toISOString(),
    });

    const contextResult = await client.post('/context', { session_id: sessionId, branch });

    if (contextResult.ok && contextResult.data?.text) {
      process.stdout.write(contextResult.data.text);
    } else {
      const index = new MycoIndex(path.join(VAULT_DIR, 'index.db'));
      const injected = buildInjectedContext(index, config, { branch });
      if (injected.text) process.stdout.write(injected.text);
      index.close();
    }
  } catch (error) {
    process.stderr.write(`[myco] session-start error: ${(error as Error).message}\n`);
  }
}

function spawnDaemon(vaultDir: string): void {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(import.meta.dirname, '..', '..');
  const daemonScript = path.join(pluginRoot, 'dist', 'src', 'daemon', 'main.js');
  if (!fs.existsSync(daemonScript)) return;

  const child = spawn('node', [daemonScript, '--vault', vaultDir], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

main();
