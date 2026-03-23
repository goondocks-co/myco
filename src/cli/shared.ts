import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SymbiontRegistry } from '../symbionts/registry.js';
import { OllamaBackend } from '../intelligence/ollama.js';
import { LmStudioBackend } from '../intelligence/lm-studio.js';

export { parseStringFlag, parseIntFlag } from '../logs/format.js';

/** Load .env from cwd (not script location — that's the plugin install dir). */
export function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// --- Provider defaults (sourced from backend classes) ---
export const PROVIDER_DEFAULTS: Record<string, { base_url: string }> = {
  ollama: { base_url: OllamaBackend.DEFAULT_BASE_URL },
  'lm-studio': { base_url: LmStudioBackend.DEFAULT_BASE_URL },
};


export const VAULT_GITIGNORE = `# PGlite database — rebuilt from capture data
pgdata/

# Daemon state — per-machine, ephemeral
daemon.json
buffer/
logs/

# Binary attachments — screenshots captured from transcripts
attachments/
`;

/** Collapse an absolute home-dir path to its `~/` form for portable config storage. */
export function collapseHomePath(absPath: string): string {
  const home = os.homedir();
  if (absPath.startsWith(home + path.sep) || absPath === home) {
    return '~' + absPath.slice(home.length);
  }
  return absPath;
}

/** Set MYCO_VAULT_DIR in the active agent's config, falling back to all known agents. */
export function configureVaultEnv(projectRoot: string, vaultDir: string): void {
  const registry = new SymbiontRegistry();
  const active = registry.detectActiveAgent();
  // Store the portable ~/... form so config files don't leak the username
  const portableDir = collapseHomePath(vaultDir);

  if (active) {
    if (active.configureVaultEnv(projectRoot, portableDir)) {
      console.log(`Set MYCO_VAULT_DIR for ${active.displayName}`);
    }
  } else {
    // No active agent detected — try all adapters
    for (const name of registry.adapterNames) {
      const adapter = registry.getAdapter(name);
      if (adapter?.configureVaultEnv(projectRoot, portableDir)) {
        console.log(`Set MYCO_VAULT_DIR for ${adapter.displayName}`);
      }
    }
  }

  console.log(`\nFor other agents, add to your shell profile:`);
  console.log(`  export MYCO_VAULT_DIR="${portableDir}"\n`);
}
