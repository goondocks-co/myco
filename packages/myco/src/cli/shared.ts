import { isMemberHome, memberHomeDaemonRefusal } from '../member/home-role.js';
import { resolveMycoHome } from '../paths/home.js';
import type { DaemonClient } from '../daemon/client.js';

export { parseStringFlag } from '../logs/format.js';

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
  const { initDatabase, closeDatabase } = await import('../db/client.js');
  const { databasePath } = resolveDaemonDataPaths(vaultDir);
  initDatabase(databasePath);
  return closeDatabase;
}

/** Exit with the reason when this home is a 2.0 member home, where no 1.4 daemon runs. */
function refuseForMemberHome(): void {
  const mycoHome = resolveMycoHome({ env: process.env });
  if (!isMemberHome(mycoHome)) return;
  console.error(memberHomeDaemonRefusal(mycoHome));
  process.exit(1);
}

/** Connect to the daemon, ensuring it's running. Exits on failure. */
export async function connectToDaemon(vaultDir: string): Promise<DaemonClient> {
  const { DaemonClient } = await import('../daemon/client.js');
  const { requestContextFromEnvironment } = await import('../grove/request-context.js');
  const client = new DaemonClient(vaultDir, {
    requestContext: requestContextFromEnvironment(process.env, vaultDir),
  });
  refuseForMemberHome();
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
  const { DaemonClient } = await import('../daemon/client.js');
  const client = new DaemonClient(vaultDir);
  refuseForMemberHome();
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
  const { DaemonClient } = await import('../daemon/client.js');
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

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
