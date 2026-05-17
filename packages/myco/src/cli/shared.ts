import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OllamaBackend } from '../intelligence/ollama.js';
import { LmStudioBackend } from '../intelligence/lm-studio.js';

import { DaemonClient } from '../hooks/client.js';
import { initDatabase, closeDatabase, vaultDbPath } from '../db/client.js';
import { requestContextFromEnvironment } from '../tools/request-context.js';
import { SymbiontInstaller } from '../symbionts/installer.js';
import type { SymbiontManifest } from '../symbionts/manifest-schema.js';

export { parseStringFlag, parseIntFlag } from '../logs/format.js';

export function isHelpRequest(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

export function printHelpIfRequested(args: readonly string[], usage: string): boolean {
  if (!isHelpRequest(args)) return false;
  process.stdout.write(usage);
  return true;
}

/**
 * Initialize the singleton database for direct CLI reads.
 * Used by CLI commands that only need reads (stats, search, session).
 * Does NOT require the daemon to be running — WAL mode allows concurrent reads.
 *
 * Resolves the active DB via the daemon data-paths helper, which means
 * Grove-bound projects open the Grove DB and pre-Grove vaults still
 * open the legacy `.myco/myco.db`. After Grove activation + archive,
 * the legacy file moves into `.archive-<ts>/`, so reading it directly
 * here would fail.
 *
 * @returns a cleanup function that closes the database.
 */
export async function initVaultDb(vaultDir: string): Promise<() => void> {
  const { resolveDaemonDataPaths } = await import('@myco/daemon/data-paths.js');
  const { databasePath } = resolveDaemonDataPaths(vaultDir);
  initDatabase(databasePath);
  return closeDatabase;
}

/** Connect to the daemon, ensuring it's running. Exits on failure. */
export async function connectToDaemon(vaultDir: string): Promise<DaemonClient> {
  const client = new DaemonClient(vaultDir, {
    requestContext: requestContextFromEnvironment(process.env, vaultDir),
  });
  const healthy = await client.ensureRunning();
  if (!healthy) {
    console.error('Failed to connect to daemon');
    process.exit(1);
  }
  return client;
}

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


// Re-exported from `vault/gitignore.ts` so existing call sites
// (`cli/init.ts`, `cli/update.ts`) keep their imports unchanged. The
// canonical body lives there so activation/grove code can import it
// without dragging in cli-level transitive dependencies.
export { VAULT_GITIGNORE, ensureVaultGitignoreCurrent } from '../vault/gitignore.js';

/** Collapse an absolute home-dir path to its `~/` form for portable config storage. */
export function collapseHomePath(absPath: string): string {
  const home = os.homedir();
  if (absPath.startsWith(home + path.sep) || absPath === home) {
    return '~' + absPath.slice(home.length);
  }
  return absPath;
}

/**
 * Run the SymbiontInstaller for each symbiont manifest and log results.
 * Shared between myco init and myco update.
 *
 * `vaultDir` overrides where the installer reads project config from.
 * Defaults to `<projectRoot>/.myco`. The worktree-bootstrap path in
 * `myco init --worktree` uses this to point config reads at the main
 * repo's shared vault while writing hook files into the worktree.
 */
export function registerSymbionts(
  manifests: SymbiontManifest[],
  projectRoot: string,
  packageRoot: string,
  verb: 'Registered' | 'Updated',
  vaultDir?: string,
): number {
  let count = 0;
  for (const manifest of manifests) {
    try {
      const installer = new SymbiontInstaller(manifest, projectRoot, packageRoot, false, vaultDir);
      const result = installer.install();

      const installed = [
        result.hooks && 'hooks',
        result.mcp && 'MCP server',
        result.skills && 'skills',
        result.settings && 'settings',
        result.instructions && 'instructions',
        result.pluginPackage && 'plugin deps',
      ].filter(Boolean);

      if (installed.length > 0) {
        console.log(`  \u2713 ${verb} ${manifest.displayName}: ${installed.join(', ')}`);
        count++;
      } else {
        console.log(`  \u2013 ${manifest.displayName}: no registration targets configured`);
      }
    } catch (err) {
      console.error(`  \u2717 Failed to register ${manifest.displayName}: ${(err as Error).message}`);
    }
  }
  return count;
}
