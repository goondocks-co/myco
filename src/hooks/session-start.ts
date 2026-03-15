import { loadConfig } from '../config/loader.js';
import { MycoIndex } from '../index/sqlite.js';
import { buildInjectedContext } from '../context/injector.js';
import { resolveVaultDir } from '../vault/resolve.js';
// execSync is safe here: command is fully static, no user input is interpolated
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const VAULT_DIR = resolveVaultDir();

  // Graceful cold start — if vault doesn't exist, skip silently
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) {
    return;
  }

  try {
    const config = loadConfig(VAULT_DIR);
    const index = new MycoIndex(path.join(VAULT_DIR, 'index.db'));

    // Detect current git branch
    let branch: string | undefined;
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    } catch {
      // Not a git repo or git not available
    }

    // Build and inject context
    const injected = buildInjectedContext(index, config, { branch });

    if (injected.text) {
      // Output context for Claude Code to inject
      console.log(injected.text);
    }

    index.close();
  } catch (error) {
    // OAK lesson: hooks must never crash the host agent
    console.error(`[myco] session-start error: ${(error as Error).message}`);
  }
}

main();
