import { DaemonClient } from './client.js';
import { readStdin } from './read-stdin.js';
import { resolveVaultDir } from '../vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const input = JSON.parse(await readStdin());
    const sessionId = input.session_id ?? process.env.MYCO_SESSION_ID;

    const client = new DaemonClient(VAULT_DIR);
    if (sessionId) {
      await client.post('/sessions/unregister', { session_id: sessionId });
    }
  } catch (error) {
    process.stderr.write(`[myco] session-end error: ${(error as Error).message}\n`);
  }
}

main();
