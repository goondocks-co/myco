import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  DAEMON_CLIENT_TIMEOUT_MS,
  DAEMON_CAPTURE_RECOVERY_COALESCE_MS,
  DAEMON_HEALTH_CHECK_TIMEOUT_MS,
  DAEMON_HEALTH_RETRY_DELAYS,
  DAEMON_RESTART_HEALTH_DEADLINE_MS,
  DAEMON_RESTART_POLL_INTERVAL_MS,
  DAEMON_SPAWN_COALESCE_MS,
  DAEMON_STALE_GRACE_PERIOD_MS,
  DAEMON_STUCK_DETECTION_MS,
} from '../constants.js';
import { findPidsListeningOn, isProcessAlive } from '@goondocks/myco-shared';
import { getPluginVersion } from '../version.js';
import {
  REQUEST_CONTEXT_AUTH_ENV,
  REQUEST_CONTEXT_AUTH_HEADER,
  REQUEST_CONTEXT_ENV,
  requestContextFromEnvironment,
  requestContextHeaders,
  type MycoRequestContext,
} from '../tools/request-context.js';
import {
  daemonStateMtimeMs,
  readDaemonState,
  resolveDaemonServiceState,
  type DaemonServiceState,
} from '../daemon/service-state.js';
import { findInstalledServiceLabel } from '../daemon/api/restart.js';
import { getServiceManager } from '../service/manager.js';
import { serviceVariantForState } from '../service/labels.js';
import type { ServiceManager } from '../service/types.js';

export interface DaemonInfo {
  pid: number;
  port: number;
  /**
   * Daemon-issued bearer token (G4). Present when the daemon writes
   * `daemon.json` with an `auth_token`; absent for pre-G4 state files.
   * Out-of-band callers (e.g. the stdio MCP bridge) that build their
   * own HTTP transport must attach this as `x-myco-auth` whenever
   * they send context-switching headers, or the daemon's gate rejects
   * the request with `UnauthorizedRequestContextError`.
   */
  auth_token?: string;
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

interface RequestFailureRecovery {
  captureCritical?: boolean;
}

interface DaemonClientOptions {
  requestContext?: MycoRequestContext;
  headers?: Record<string, string>;
  /** Optional override for the platform service manager. Defaults to
   *  `getServiceManager()`. Tests inject a fake to bypass real launchd /
   *  systemd state on the host. */
  serviceManager?: ServiceManager;
}

interface HookRequestContextInput {
  sessionId?: string | null;
}

/**
 * Pluggable surface for {@link DaemonClient.restart}'s stuck-shutdown
 * recovery loop. All fields default to the production implementations;
 * tests inject fakes to drive the three observed states (healthy quickly,
 * wedged listener, dead PID waiting for supervisor) deterministically.
 */
export interface RestartDeps {
  isProcessAlive?: (pid: number) => boolean;
  /** Returns true when `pid` (the prior daemon) is the listener bound to
   *  `port`. Pass-through to lsof / ss / netstat in production. */
  isPortBound?: (port: number, pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stuckDetectionMs?: number;
  deadlineMs?: number;
  pollIntervalMs?: number;
}

function defaultIsPortBound(port: number, pid: number): boolean {
  try {
    const owners = findPidsListeningOn([port]);
    return owners.some((owner) => owner.pid === pid && owner.port === port);
  } catch {
    return false;
  }
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
  private daemonService: DaemonServiceState;
  private serviceManager: ServiceManager | null;

  constructor(vaultDir: string, options: DaemonClientOptions = {}) {
    this.vaultDir = vaultDir;
    this.daemonService = resolveDaemonServiceState(vaultDir, {
      requestContext: options.requestContext,
      env: process.env,
    });
    this.defaultHeaders = {
      ...(options.requestContext ? requestContextHeaders(options.requestContext) : {}),
      ...resolveDaemonAuthHeader(this.daemonService.statePath),
      ...(options.headers ?? {}),
    };
    this.serviceManager = options.serviceManager ?? null;
  }

  async post(endpoint: string, body: unknown, options?: ClientOptions): Promise<ClientResult> {
    return this.postWithRecovery(endpoint, body, options);
  }

  /**
   * POST for capture-critical hook writes. If transport times out or the
   * daemon socket fails, recover the owning service instead of only spawning:
   * a managed daemon can still be "running" while routed ingestion is wedged.
   */
  async capturePost(endpoint: string, body: unknown, options?: ClientOptions): Promise<ClientResult> {
    return this.postWithRecovery(endpoint, body, options, { captureCritical: true });
  }

  private async postWithRecovery(
    endpoint: string,
    body: unknown,
    options?: ClientOptions,
    recovery?: RequestFailureRecovery,
  ): Promise<ClientResult> {
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
      await this.recoverAfterRequestFailure(recovery);
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
      await this.recoverAfterRequestFailure();
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
      await this.recoverAfterRequestFailure();
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
      await this.recoverAfterRequestFailure();
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

  async isReady(cachedInfo?: DaemonInfo | null): Promise<boolean> {
    try {
      const info = cachedInfo ?? this.readDaemonJson();
      if (!info) return false;

      const res = await fetch(`http://127.0.0.1:${info.port}/ready`, {
        headers: this.requestHeaders(),
        signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const data = await res.json() as { ready?: boolean };
      return data.ready === true;
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
      const mtimeMs = daemonStateMtimeMs(this.daemonService.statePath);
      if (mtimeMs !== null && Date.now() - mtimeMs < DAEMON_STALE_GRACE_PERIOD_MS) {
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

  // SIGTERM only. Never unlinks daemon.json — see reconcileExistingDaemon
  // for the cleanup-ownership-inversion rationale (the canonical comment).
  private killDaemon(info: DaemonInfo | null): void {
    if (!info) return;
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch { /* already dead */ }
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

  /**
   * Async sibling of `getInfo()` that falls back to a `/health` probe
   * on the canonical port when daemon.json is missing or stale. The
   * sync `getInfo()` returns null in that case, which loses sight of a
   * healthy daemon any time the state file is externally nuked between
   * its write and the daemon's next self-reconcile tick.
   *
   * The reconstructed `DaemonInfo` omits `auth_token` because /health
   * deliberately doesn't expose it. Callers that need the bearer
   * (context-switching requests) must wait for the daemon's next
   * self-reconcile tick to re-write daemon.json.
   */
  async getInfoAsync(): Promise<DaemonInfo | null> {
    const direct = this.readDaemonJson();
    if (direct) return direct;
    return this.discoverViaHealth();
  }

  /**
   * Probe `/health` on the variant's canonical port. Used as a
   * last-resort discovery path when daemon.json is missing. Returns
   * null on any failure — a missing or non-Myco response, an
   * unverifiable pid, or any network error is indistinguishable from
   * "no daemon" for caller purposes.
   *
   * Cross-checks the response's `pid` against the local OS before
   * returning. Without this, a buggy or compromised process on the
   * canonical port responding `{myco:true, pid:99999}` would steer
   * callers at kill/restart paths that target a fabricated pid.
   */
  private async discoverViaHealth(): Promise<DaemonInfo | null> {
    const port = this.daemonService.canonicalPort;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = await res.json() as { myco?: boolean; version?: string; pid?: number };
      if (data.myco !== true || typeof data.pid !== 'number') return null;
      if (!isProcessAlive(data.pid)) return null;
      return { pid: data.pid, port };
    } catch {
      return null;
    }
  }

  private requestHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
    if (Object.keys(this.defaultHeaders).length === 0) return headers;
    return { ...this.defaultHeaders, ...(headers ?? {}) };
  }

  /**
   * Bounce the daemon and wait for the new instance to become healthy.
   *
   * Stuck-shutdown recovery: when the SIGTERM-driven restart wedges (the old
   * daemon's TCP listener stays bound but /health stops responding — observed
   * during a deep deadlock or a shutdown handler hang), the CLI was previously
   * forced to manually `kill -9` the PID. This loop now detects that signature
   * — prev PID still alive AND port still bound AND /health silent for
   * `DAEMON_STUCK_DETECTION_MS` — and escalates to SIGKILL once, then lets
   * launchd / systemd KeepAlive respawn the daemon. If /health is already
   * silent because the PID is already dead, no escalation fires — we just keep
   * polling for the supervisor to respawn.
   *
   * `deps` is exposed for unit tests; production callers use the defaults.
   */
  async restart(
    _opts?: { checkStale?: boolean },
    deps?: RestartDeps,
  ): Promise<boolean> {
    const d: Required<RestartDeps> = {
      isProcessAlive: deps?.isProcessAlive ?? isProcessAlive,
      isPortBound: deps?.isPortBound ?? defaultIsPortBound,
      kill: deps?.kill ?? ((pid, sig) => process.kill(pid, sig)),
      now: deps?.now ?? (() => Date.now()),
      sleep: deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      stuckDetectionMs: deps?.stuckDetectionMs ?? DAEMON_STUCK_DETECTION_MS,
      deadlineMs: deps?.deadlineMs ?? DAEMON_RESTART_HEALTH_DEADLINE_MS,
      pollIntervalMs: deps?.pollIntervalMs ?? DAEMON_RESTART_POLL_INTERVAL_MS,
    };

    const prevInfo = this.readDaemonJson();
    const prevPid = prevInfo?.pid;
    const prevPort = prevInfo?.port;

    // Initiate the bounce. killDaemon issues SIGTERM but never unlinks
    // daemon.json — the successor's reconcileExistingDaemon owns state-file
    // cleanup once the recorded pid is confirmed dead. spawnDaemon (or the
    // service supervisor's KeepAlive) brings a fresh daemon up, which
    // overwrites daemon.json with its own pid as part of normal startup.
    this.killDaemon(prevInfo);
    // Kick the spawn / supervisor start without blocking on retry delays —
    // the unified poll loop below is the single source of truth for the
    // deadline and stuck-detection behavior.
    void this.spawnDaemon();

    const startedAt = d.now();
    let stuckEscalated = false;
    while (d.now() - startedAt < d.deadlineMs) {
      if (await this.isHealthy()) return true;

      if (
        !stuckEscalated &&
        prevPid !== undefined &&
        prevPort !== undefined &&
        d.now() - startedAt >= d.stuckDetectionMs &&
        d.isProcessAlive(prevPid) &&
        d.isPortBound(prevPort, prevPid)
      ) {
        try { d.kill(prevPid, 'SIGKILL'); } catch { /* already dead */ }
        stuckEscalated = true;
        // Loop continues; the supervisor's KeepAlive should respawn shortly.
      }

      await d.sleep(d.pollIntervalMs);
    }

    return this.isHealthy();
  }

  async spawnDaemon(): Promise<void> {
    // Tests set MYCO_NO_AUTO_SPAWN=1 to suppress fork side effects when
    // exercising the "daemon down" path.
    if (process.env.MYCO_NO_AUTO_SPAWN === '1') return;
    // Coalesce concurrent spawns: if daemon state was written within the
    // coalesce window AND its pid is still alive, another spawn is already in
    // flight — defer to it instead of forking another process. Safe to call
    // from every failed request path (post/get/put/delete all invoke it), so
    // any hook activity — not just session-start — resurrects a dead daemon.
    // The daemon's own step-aside guard backs this up.
    if (this.spawnIsInFlight()) return;

    // Service-managed daemons: defer to the supervisor. Spawning a raw child
    // here would race with launchd's KeepAlive / systemd's Restart=always —
    // the challenger comes up, fails to bind the port the service owns, and
    // self-SIGTERMs via the sibling-stepping-aside path. Same root cause as
    // the /restart and update-flow bypasses fixed earlier in this branch.
    try {
      const mgr = this.serviceManager ?? getServiceManager();
      const installed = await findInstalledServiceLabel(mgr, serviceVariantForState(this.daemonService));
      if (installed) {
        if (!installed.status.running) {
          // Supervisor knows about the service but isn't running it (cold
          // boot, throttle window). Ask it to start; the supervisor handles
          // port / lifecycle correctly. Fire-and-forget — the next probe
          // will discover whether the start succeeded.
          await mgr.start(installed.label).catch(() => { /* best-effort */ });
        }
        return;
      }
    } catch {
      // Service manager unavailable on this platform, or transient lookup
      // failure. Fall through to the legacy raw-spawn path so manual dev
      // runs and test fixtures keep working.
    }

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
      const mtimeMs = daemonStateMtimeMs(this.daemonService.statePath);
      if (mtimeMs === null || Date.now() - mtimeMs >= DAEMON_SPAWN_COALESCE_MS) return false;
      const info = this.readDaemonJson();
      if (!info?.pid) return false;
      try { process.kill(info.pid, 0); return true; }
      catch { return false; }
    } catch {
      return false;
    }
  }

  private readDaemonJson(): DaemonInfo | null {
    return readDaemonState(this.daemonService.statePath);
  }

  private async recoverAfterRequestFailure(recovery?: RequestFailureRecovery): Promise<void> {
    if (!recovery?.captureCritical) {
      await this.spawnDaemon();
      return;
    }

    if (this.captureRecoveryRecentlyRequested()) return;

    try {
      const mgr = this.serviceManager ?? getServiceManager();
      const installed = await findInstalledServiceLabel(mgr, serviceVariantForState(this.daemonService));
      if (installed) {
        await mgr.restart(installed.label).catch(() => { /* best-effort */ });
        return;
      }
    } catch {
      // Fall through to legacy spawn recovery.
    }

    await this.spawnDaemon();
  }

  private captureRecoveryRecentlyRequested(): boolean {
    try {
      const markerPath = path.join(this.daemonService.stateDir, 'capture-recovery.json');
      const stat = fs.existsSync(markerPath) ? fs.statSync(markerPath) : null;
      if (stat && Date.now() - stat.mtimeMs < DAEMON_CAPTURE_RECOVERY_COALESCE_MS) return true;
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({ requested_at: new Date().toISOString() }));
    } catch {
      return false;
    }
    return false;
  }
}

export function requestContextForHook(
  vaultDir: string,
  input: HookRequestContextInput = {},
): MycoRequestContext {
  const env: Record<string, string | undefined> = { ...process.env };
  if (input.sessionId) env[REQUEST_CONTEXT_ENV.sessionId] = input.sessionId;
  env[REQUEST_CONTEXT_ENV.callerRoot] ??= process.cwd();
  return requestContextFromEnvironment(env, vaultDir);
}

export function createHookDaemonClient(
  vaultDir: string,
  input: HookRequestContextInput = {},
): DaemonClient {
  return new DaemonClient(vaultDir, { requestContext: requestContextForHook(vaultDir, input) });
}

/**
 * Resolve the daemon-issued bearer token (G4). Spawned children
 * inherit it via env; out-of-band invocations recover it from
 * `daemon.json`. Returns the headers ready to merge into a fetch
 * request — empty when no token is available, so the gate stays a
 * no-op for callers the daemon did not produce.
 */
function resolveDaemonAuthHeader(daemonStatePath: string): Record<string, string> {
  const fromEnv = process.env[REQUEST_CONTEXT_AUTH_ENV];
  if (fromEnv) return { [REQUEST_CONTEXT_AUTH_HEADER]: fromEnv };
  const state = readDaemonState(daemonStatePath);
  if (state?.auth_token) return { [REQUEST_CONTEXT_AUTH_HEADER]: state.auth_token };
  return {};
}
