import { MycoIndex } from '../index/sqlite.js';
import { initFts } from '../index/fts.js';
import { resolveVaultDir } from '../vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    // Ensure index is up to date and FTS is initialized
    const index = new MycoIndex(path.join(VAULT_DIR, 'index.db'));
    initFts(index);

    // TODO: Generate embeddings for new notes
    // TODO: Clean up stale PID files

    index.close();
  } catch (error) {
    console.error(`[myco] session-end error: ${(error as Error).message}`);
  }
}

main();
