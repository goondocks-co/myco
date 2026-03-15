import { DaemonClient } from './client.js';
import { MycoIndex } from '../index/sqlite.js';
import { initFts } from '../index/fts.js';
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

    const index = new MycoIndex(path.join(VAULT_DIR, 'index.db'));
    initFts(index);
    index.close();
  } catch (error) {
    process.stderr.write(`[myco] session-end error: ${(error as Error).message}\n`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk: Buffer) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), 100);
  });
}

main();
