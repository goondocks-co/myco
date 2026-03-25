import { DaemonClient } from './client.js';
import { readStdin } from './read-stdin.js';
import { loadConfig } from '../config/loader.js';
import { buildInjectedContext } from '../context/injector.js';
import { initDatabase, vaultDbPath } from '../db/client.js';
import { createSchema } from '../db/schema.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const config = loadConfig(VAULT_DIR);
    const client = new DaemonClient(VAULT_DIR);
    const healthy = await client.ensureRunning();

    const input = JSON.parse(await readStdin());
    const sessionId = input.session_id ?? `s-${Date.now()}`;

    let branch: string | undefined;
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
    } catch { /* not a git repo */ }

    if (healthy) {
      await client.post('/sessions/register', {
        session_id: sessionId,
        branch,
        started_at: new Date().toISOString(),
      });

      const contextResult = await client.post('/context', { session_id: sessionId, branch });

      if (contextResult.ok && contextResult.data?.text) {
        if (contextResult.data.source === 'digest') {
          process.stderr.write(`[myco] Injecting digest extract (tier ${contextResult.data.tier})\n`);
        }
        process.stdout.write(contextResult.data.text);
        return;
      }
    }

    // Degraded: local SQLite context only
    const db = initDatabase(vaultDbPath(VAULT_DIR));
    createSchema(db);
    const injected = await buildInjectedContext(config, { branch });
    if (injected.text) process.stdout.write(injected.text);
  } catch (error) {
    process.stderr.write(`[myco] session-start error: ${(error as Error).message}\n`);
  }
}
