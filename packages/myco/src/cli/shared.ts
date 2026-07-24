import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OllamaBackend } from '../intelligence/ollama.js';
import { LmStudioBackend } from '../intelligence/lm-studio.js';

import { DaemonClient } from '../hooks/client.js';
import { initDatabase, closeDatabase, vaultDbPath } from '../db/client.js';
import { requestContextFromEnvironment } from '../grove/request-context.js';

export { parseStringFlag, parseIntFlag } from '../logs/format.js';

export function isHelpRequest(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

/**
 * Parse `--flag value` / `--flag=value` / bare `--flag` into positionals plus
 * a flag map. Shared by `cli/attach.ts` and `cli/join.ts` — the member-overlay
 * commands (`myco attach`/`detach`/`join`/`leave`) — so they parse identically.
 */
export function parseFlags(args: string[]): { positionals: string[]; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq > 2) { flags.set(arg.slice(2, eq), arg.slice(eq + 1)); continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(arg.slice(2), next); i += 1; }
    else flags.set(arg.slice(2), 'true');
  }
  return { positionals, flags };
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

/**
 * Connect to the daemon for MACHINE-GLOBAL commands that must work from any
 * cwd, including one with no registered project at all (`join`/`leave`/
 * `attach`/`detach` — Task D-2's daemon-API fallback wrappers). Deliberately
 * skips {@link connectToDaemon}'s `requestContext: requestContextFromEnvironment(...)`:
 * that call throws `UnknownRequestContextError` for a `vaultDir` with no Grove
 * project id, which is the NORMAL case here (these commands sit above the
 * `myco.yaml` gate precisely so they work before a project is registered).
 * The routes these commands call (`/api/host-membership/*`) read identity
 * from the POST body, not request-context headers, so no header derivation
 * is needed anyway.
 */
export async function connectToGlobalDaemon(vaultDir: string): Promise<DaemonClient> {
  const client = new DaemonClient(vaultDir);
  const healthy = await client.ensureRunning();
  if (!healthy) {
    console.error('Failed to connect to daemon');
    process.exit(1);
  }
  return client;
}

/**
 * Like {@link connectToGlobalDaemon}, but REFUSES instead of spawning when no
 * daemon is already running. For commands whose daemon-side work consumes
 * something irreplaceable mid-flight: `join` burns the single-use overlay key
 * at the `tailscale up` step, so it must never ride on an `ensureRunning()`-
 * spawned daemon — one spawned as a side effect of the command (e.g. under a
 * closing ssh session) can die mid-join AFTER the key is consumed, leaving the
 * node logged out and the key unrecoverable. `isHealthy()` only probes
 * (daemon.json → lock → /health); it never spawns, so the daemon-less case is
 * an up-front refusal with nothing spent.
 */
export async function connectToRunningDaemon(vaultDir: string, refusal: string): Promise<DaemonClient> {
  const client = new DaemonClient(vaultDir);
  if (!(await client.isHealthy())) {
    console.error(refusal);
    process.exit(1);
  }
  return client;
}

/**
 * Extract a human-readable message from a daemon API error body. Recognizes
 * the structured `{ error: { code, message } }` envelope (`error-envelope.ts`
 * `errorBody`, used by newer routes including `host-membership.ts`) alongside
 * the older ad hoc shapes (`{ status }` / `{ message }` / `{ error: string }`)
 * so one helper covers both generations without every CLI wrapper re-deriving
 * its own parsing.
 */
export function daemonErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  if (obj.error && typeof obj.error === 'object') {
    const err = obj.error as Record<string, unknown>;
    if (typeof err.message === 'string') return err.message;
  }
  if (typeof obj.status === 'string') return obj.status;
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.error === 'string') return obj.error;
  return null;
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
// Vault gitignore is now owned by ProjectVault — see
// `@myco/vault/project-vault.ts`. Callers that need to refresh
// `<projectRoot>/.myco/.gitignore` go through
// `new ProjectVault(projectRoot).ensureGitignore()`; the helper isn't
// re-exported here to keep the single-writer contract honest.

/** Collapse an absolute home-dir path to its `~/` form for portable config storage. */
export function collapseHomePath(absPath: string): string {
  const home = os.homedir();
  if (absPath.startsWith(home + path.sep) || absPath === home) {
    return '~' + absPath.slice(home.length);
  }
  return absPath;
}
