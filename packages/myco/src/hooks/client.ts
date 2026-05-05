import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DAEMON_CLIENT_TIMEOUT_MS, DAEMON_HEALTH_CHECK_TIMEOUT_MS, DAEMON_HEALTH_RETRY_DELAYS, DAEMON_SPAWN_COALESCE_MS, DAEMON_STALE_GRACE_PERIOD_MS } from '../constants.js';
import { getPluginVersion } from '../version.js';
import {
  REQUEST_CONTEXT_ENV,
  requestContextFromEnvironment,
  requestContextHeaders,
  type MycoRequestContext,
} from '../tools/request-context.js';

export interface DaemonInfo {
  pid: number;
  port: number;
}

/**
 * Resolve the CLI entry point for spawning daemon processes.
 *
 * In dev mode (tsx / bun run), `process.argv[1]` is the entry script path
 * that `process.execPath` should re-execute. In a Bun-compiled binary,
 * `process.argv[1]` is a virtual Bun-filesystem path like
 * `/$bunfs/root/cli.darwin-arm64.js` — a real path would incorrectly pass it
 * through to a child invocation that treats it as a subcommand.
 *
 * Detect the compiled case by the `/$bunfs/` prefix; in that case the binary
 * is its own entry and no extra argv element is needed.
 */
export function resolveCliEntryPath(): { execPath: string; cliEntry: string | null } {
  const argv1 = process.argv[1];
  if (!argv1 || argv1.startsWith('/$bunfs/') || argv1.startsWith('B:\\~BUN\\')) {
    return { execPath: process.execPath, cliEntry: null };
  }
  return { execPath: process.execPath, cliEntry: argv1 };
}

/** Build the argv for re-exec'ing this binary with a subcommand. */
export function buildReExecArgs(cliEntry: string | null, subcommand: string[]): string[] {
  return cliEntry === null ? subcommand : [cliEntry, ...subcommand];
}

interface HealthResponse {
  myco: boolean;
  version?: string;
}

interface ClientResult {
  ok: boolean;
  data?: any;
}

interface ClientOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

interface DaemonClientOptions {
  requestContext?: MycoRequestContext;
  headers?: Record<string, string>;
}

interface HookRequestContextInput {
  sessionId?: string | null;
}

/**
 * Attempt to parse a non-ok response body as JSON so callers can surface
 * the daemon's structured error envelope (e.g. `{error: {code, message}}`).
 * Returns `undefined` if the body is empty, not JSON, or otherwise fails to
 * parse — callers that ignore `data` on failure still work unchanged.
 */
async function parseErrorBody(res: Response): Promise<unknown> {
  try {
    // Node's undici returns `undefined` for an empty body, Bun's fetch returns
    // `null`. Normalize to `undefined` so consumers can treat both the same.
    const parsed = await res.json();
    return parsed === null ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/**
 * True when the daemon returned 200 but its body carries `{ ignored: reason }`.
 *
 * Callers that write to the event buffer on failure also buffer on this
 * signal — otherwise a capture-rule drop discards events silently even though
 * the HTTP call "succeeded". reconcileBufferBatches replays on next startup.
 */
export function isIgnoredEventResponse(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const ignored = (data as Record<string, unknown>).ignored;
  return typeof ignored === 'string' && ignored.length > 0;
}

export class DaemonClient {
  private vaultDir: string;
  private defaultHeaders: Record<string, string>;

  constructor(vaultDir: string, options: DaemonClientOptions = {}) {
    this.vaultDir = vaultDir;
    this.defaultHeaders = {
      ...(options.requestContext ? requestContextHeaders(options.requestContext) : {}),
      ...(options.headers ?? {}),
    };
  }

  async post(endpoint: string, body: unknown, options?: ClientOptions): Promise<ClientResult> {
    const info = this.readDaemonJson();
    if (!info) {
      this.spawnDaemon();
      return { ok: false };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.requestHeaders(options?.headers) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options?.timeoutMs ?? DAEMON_CLIENT_TIMEOUT_MS),
      });

      if (!res.ok) return { ok: false, data: await parseErrorBody(res) };
      const data = await res.json();
      return { ok: true, data };
    } catch {
      this.spawnDaemon();
      return { ok: false };
    }
  }

  async put(endpoint: string, body: unknown, options?: ClientOptions): Promise<ClientResult> {
    const info = this.readDaemonJson();
    if (!info) {
      this.spawnDaemon();
      return { ok: false };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}${endpoint}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...this.requestHeaders(options?.headers) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DAEMON_CLIENT_TIMEOUT_MS),
      });

      if (!res.ok) return { ok: false, data: await parseErrorBody(res) };
      const data = await res.json();
      return { ok: true, data };
    } catch {
      this.spawnDaemon();
      return { ok: false };
    }
  }

  async get(endpoint: string, options?: ClientOptions): Promise<ClientResult> {
    const info = this.readDaemonJson();
    if (!info) {
      this.spawnDaemon();
      return { ok: false };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}${endpoint}`, {
        headers: this.requestHeaders(options?.headers),
        signal: AbortSignal.timeout(DAEMON_CLIENT_TIMEOUT_MS),
      });

      if (!res.ok) return { ok: false, data: await parseErrorBody(res) };
      const data = await res.json();
      return { ok: true, data };
    } catch {
      this.spawnDaemon();
      return { ok: false };
    }
  }

  async delete(endpoint: string, body?: unknown, options?: ClientOptions): Promise<ClientResult> {
    const info = this.readDaemonJson();
    if (!info) {
      this.spawnDaemon();
      return { ok: false };
    }
    try {
      const init: RequestInit = {
        method: 'DELETE',
        signal: AbortSignal.timeout(DAEMON_CLIENT_TIMEOUT_MS),
      };
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json', ...this.requestHeaders(options?.headers) };
        init.body = JSON.stringify(body);
      } else {
        const headers = this.requestHeaders(options?.headers);
        if (headers) init.headers = headers;
      }

      const res = await fetch(`http://127.0.0.1:${info.port}${endpoint}`, init);

      if (!res.ok) return { ok: false, data: await parseErrorBody(res) };
      const data = await res.json();
      return { ok: true, data };
    } catch {
      this.spawnDaemon();
      return { ok: false };
    }
  }

  async isHealthy(cachedInfo?: DaemonInfo | null): Promise<boolean> {
    try {
      const info = cachedInfo ?? this.readDaemonJson();
      if (!info) return false;

      const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
        signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const data = await res.json() as HealthResponse;
      return data.myco === true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the daemon is running a stale version.
   * Returns true if the daemon's version doesn't match the current plugin version.
   * Skips the check if daemon.json was written recently (grace period) to prevent
   * rapid restart loops from concurrent hooks or session reloads.
   */
  private async isStale(info: DaemonInfo): Promise<boolean> {
    try {
      const jsonPath = path.join(this.vaultDir, 'daemon.json');
      const stat = fs.statSync(jsonPath);
      if (Date.now() - stat.mtimeMs < DAEMON_STALE_GRACE_PERIOD_MS) {
        return false;
      }

      const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
        signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const data = await res.json() as HealthResponse;
      if (!data.myco) return false;

      // No version in response = old daemon that predates this check
      if (!data.version) return true;

      return data.version !== getPluginVersion();
    } catch {
      return false;
    }
  }

  /**
   * Kill the running daemon process.
   */
  private killDaemon(info: DaemonInfo | null): void {
    try {
      if (!info) return;
      process.kill(info.pid, 'SIGTERM');
    } catch { /* already dead */ }
    try {
      fs.unlinkSync(path.join(this.vaultDir, 'daemon.json'));
    } catch { /* already gone */ }
  }

  /**
   * Ensure the daemon is running. Spawns it if unhealthy.
   * When checkStale is true (default), also restarts a healthy daemon if its
   * version doesn't match the current plugin version. Use checkStale: false
   * for hooks that just need the daemon alive (e.g., stop) without triggering
   * version-driven restarts.
   */
  async ensureRunning(opts?: { checkStale?: boolean }): Promise<boolean> {
    const checkStale = opts?.checkStale ?? true;
    const info = this.readDaemonJson();

    if (checkStale && info && await this.isStale(info)) {
      this.killDaemon(info);
      // Brief pause for port release
      await new Promise((r) => setTimeout(r, 200));
    } else if (await this.isHealthy(info)) {
      return true;
    }

    this.spawnDaemon();

    for (const delay of DAEMON_HEALTH_RETRY_DELAYS) {
      await new Promise((r) => setTimeout(r, delay));
      if (await this.isHealthy()) return true;
    }
    return false;
  }

  /**
   * Public read of the daemon info file. Pairs with `ensureRunning()` for
   * callers that need the port after confirming the daemon is up (e.g., the
   * stdio MCP bridge connecting to the in-process tool runtime).
   */
  getInfo(): DaemonInfo | null {
    return this.readDaemonJson();
  }

  private requestHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
    if (Object.keys(this.defaultHeaders).length === 0) return headers;
    return { ...this.defaultHeaders, ...(headers ?? {}) };
  }

  async restart(opts?: { checkStale?: boolean }): Promise<boolean> {
    this.killDaemon(this.readDaemonJson());
    await new Promise((r) => setTimeout(r, 200));
    return this.ensureRunning(opts);
  }

  spawnDaemon(): void {
    // Tests set MYCO_NO_AUTO_SPAWN=1 to suppress fork side effects when
    // exercising the "daemon down" path.
    if (process.env.MYCO_NO_AUTO_SPAWN === '1') return;
    // Coalesce concurrent spawns: if daemon.json was written within the
    // coalesce window AND its pid is still alive, another spawn is already in
    // flight — defer to it instead of forking another process. Safe to call
    // from every failed request path (post/get/put/delete all invoke it), so
    // any hook activity — not just session-start — resurrects a dead daemon.
    // The daemon's own step-aside guard backs this up.
    if (this.spawnIsInFlight()) return;

    const { execPath, cliEntry } = resolveCliEntryPath();
    const child = spawn(execPath, buildReExecArgs(cliEntry, ['daemon']), {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(this.vaultDir),
    });
    child.unref();
  }

  private spawnIsInFlight(): boolean {
    try {
      const jsonPath = path.join(this.vaultDir, 'daemon.json');
      const stat = fs.statSync(jsonPath);
      if (Date.now() - stat.mtimeMs >= DAEMON_SPAWN_COALESCE_MS) return false;
      const info = this.readDaemonJson();
      if (!info?.pid) return false;
      try { process.kill(info.pid, 0); return true; }
      catch { return false; }
    } catch {
      return false;
    }
  }

  private readDaemonJson(): DaemonInfo | null {
    try {
      const jsonPath = path.join(this.vaultDir, 'daemon.json');
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const info = JSON.parse(content);
      if (typeof info.port !== 'number') return null;
      return info as DaemonInfo;
    } catch {
      return null;
    }
  }
}

export function requestContextForHook(
  vaultDir: string,
  input: HookRequestContextInput = {},
): MycoRequestContext {
  const env: Record<string, string | undefined> = { ...process.env };
  if (input.sessionId) env[REQUEST_CONTEXT_ENV.sessionId] = input.sessionId;
  return requestContextFromEnvironment(env, vaultDir);
}

export function createHookDaemonClient(
  vaultDir: string,
  input: HookRequestContextInput = {},
): DaemonClient {
  return new DaemonClient(vaultDir, { requestContext: requestContextForHook(vaultDir, input) });
}
