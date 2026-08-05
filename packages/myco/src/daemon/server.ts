import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { DaemonLogger } from './logger.js';
import { isSafeCaptureSegment, resolveTeamSocketPath } from '../grove/paths.js';
import { getPluginVersion } from '../version.js';
import { Router, type RouteHandler } from './router.js';
import { resolveStaticFile, resolveEmbeddedAsset } from './static.js';
import { evictDaemons } from './eviction.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import {
  ForeignGroveError,
  REQUEST_CONTEXT_AUTH_ENV,
  REQUEST_CONTEXT_AUTH_HEADER,
  REQUEST_CONTEXT_HEADERS,
  UnauthorizedRequestContextError,
  UnknownRequestContextError,
  enforceUrlTenancyAuth,
  enforceContextSwitchAuth,
  readHeader,
  requestContextFromHttpHeaders,
  requestContextFromTenancyIds,
  resolveInboundProjectId,
  type MycoRequestContext,
} from '../grove/request-context.js';
import { isGroveEraId, type GroveProjectId } from '../grove/ids.js';
import { createAuthThrottle, delay } from '../team-host/auth-throttle.js';
import { consumeJoinKey } from '../team-host/join-keys.js';
import {
  issueMemberToken,
  MAX_MACHINE_ID_LENGTH,
  MemberAlreadyEnrolledError,
  noteMemberSeen,
  type IssuedMemberToken,
} from '../team-host/member-tokens.js';
import { classifyRoute, classifyRouteStamp, overlayHostStampRefusal, refusalJson, resolveHostCarrierTarget, type RefusalPayload } from '../host/routing.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';
import { maybeRegisterHostedProjectOnIngest } from '../host/hosted-projects.js';
import { defaultDial, handleAttachedRequest, proxyLoggerFrom, type HostProxyDeps } from './host-proxy.js';
import { handleAttachedConfigRequest } from './attached-config.js';
import { isProjectPaused, UnknownGroveError } from '../grove/registry.js';
import { pausedErrorResponse, errorBody } from './api/error-envelope.js';
import { SchemaVersionTooNewError } from '@myco/db/schema.js';
import { PreMigrationCheckpointError } from '@myco/backup/pre-migration-checkpoint.js';
import {
  buildHostEnrollmentPayload,
  isTeamRequest,
  markTeamRequest,
  overlayBearerExempt,
  teamAuthOutcome,
  teamMachineIdRejection,
  teamRawRouteAdmitted,
  overlayVersionRejection,
  servedGroveRefusal,
  type HostServeRuntime,
} from './host-serve.js';
import { appendHostAction } from '../host/action-log.js';
import {
  EXTERNAL_MCP_ACTIVATION_POSTURE,
  HOST_ENROLL_ROUTE,
  REFUSAL_LOG_THROTTLE_INTERVAL_MS,
} from '../constants.js';
import { shouldLogOncePerInterval } from './log-throttle.js';
import { type DaemonState } from './service-state.js';
import {
  DaemonStateAuthority,
  createDaemonStateAuthority,
} from './daemon-state-authority.js';
import { resolveDaemonServiceState } from './service-state.js';
import { vaultDbPath, withDatabase, type Database } from '../db/client.js';
import { GroveRuntimeCache } from './grove-runtime-cache.js';

const DEFAULT_STATUS = 200;
/** How long we wait after `closeIdleConnections()` before force-yanking
 *  any sockets that still haven't closed. Long enough for an in-flight
 *  request to finish its response, short enough that a stale UI
 *  keep-alive doesn't make restart look broken. */
const SERVER_STOP_FORCE_CLOSE_GRACE_MS = 2_000;

/**
 * Protective limits applied to the daemon's HTTP server. Node's defaults
 * are tuned for public-internet clients (long keep-alive, slow-loris
 * tolerance, no cap on per-socket request count). On loopback we can be
 * much tighter — every legitimate client is on the same machine. Without
 * these, a misbehaving client (or even a stress test from a developer
 * shell) can pile up sockets in CLOSE_WAIT until the daemon's fd table
 * is exhausted and `accept()` starts returning EMFILE.
 */
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const HTTP_HEADERS_TIMEOUT_MS = 10_000;
/** Cap how many requests reuse a single keep-alive socket before we
 *  force a close. Without this, a single client can hold one fd open
 *  forever no matter how many requests it sends. */
const HTTP_MAX_REQUESTS_PER_SOCKET = 1_000;
/** Explicit TCP listen backlog. Node defaults to 511, which the macOS
 *  kernel further caps at `kern.ipc.somaxconn` (often 128). 4096 keeps
 *  the kernel's SYN queue deep enough that a burst of concurrent
 *  loopback connections doesn't get rejected during the brief window
 *  the daemon takes to call `accept()` on each. */
const HTTP_LISTEN_BACKLOG = 4_096;

export interface DaemonServerConfig {
  vaultDir: string;
  logger: DaemonLogger;
  /** Report the CURRENT external-MCP activation posture on `/health` — the
   *  takeover-handshake predicate reads it (eviction.ts). Defaults to the
   *  static `retired` value for callers (tests) that never activate. */
  externalMcpPosture?: () => string;
  /** Override the team listener's socket path (tests inject a short temp path). */
  teamSocketPath?: string;
  /**
   * Capability for mutating `daemon.json`. The ONLY way the server
   * writes state. Required for production callers; tests that don't
   * exercise the listen callback may omit it, in which case the server
   * constructs one from `resolveDaemonServiceState(vaultDir)`.
   */
  daemonStateAuthority?: DaemonStateAuthority;
  uiDir?: string;
  uiDevProxyTarget?: string;
  /**
   * Fired once per served request with the request's declared class. This is
   * the daemon's single wake edge: deep sleep stops the tick timer, so no
   * pull-based assertion source can revive it and something has to push.
   *
   * Left unwired for a long time on the reasoning that "UI polling every
   * 3-10s would prevent the PowerManager from ever reaching 'idle'". That
   * diagnosis was right and the conclusion too broad — the fix is for clients
   * to declare whether a request represents someone actually doing something,
   * not for the daemon to ignore requests entirely. See {@link RequestClass}.
   */
  onRequest?: (requestClass: RequestClass) => void;
  /**
   * Fired once per routed request, after the owning Grove and project have
   * been resolved. The per-project power state needs the tenancy that
   * {@link onRequest} cannot see, and this is the single site where it is
   * known — so per-project liveness stays one hook rather than one call per
   * route.
   */
  onRequestContext?: (requestContext: MycoRequestContext, requestClass: RequestClass) => void;
  /**
   * Shared bounded LRU for per-Grove DB handles + embedding runtime.
   * If omitted, the server creates a private cache; pass an externally
   * owned one when other subsystems need to share entries.
   */
  runtimeCache?: GroveRuntimeCache;
  /**
   * Team Host serve enablement (Task 2.3). When present, the server binds a
   * SECOND listener on a private unix socket where every request passes the
   * transport-boundary gate (Origin refusal + blanket bearer + fail-closed raw
   * route admission + version window). When `null`/omitted, host serving is off
   * and only the loopback listener binds.
   * Resolved by `resolveHostServeConfig` (machine config + bearer) in main.ts.
   */
  hostServe?: HostServeRuntime | null;
  /**
   * Capture-side proxy deps threaded into `handleAttachedRequest` for attached
   * (routed) projects: the transcript-drain queue's `flushBeforeForward` (drain
   * pending bytes before a terminal mining-trigger route) and `noteCollectEvent`
   * (enqueue on every collect event). Wired at BOTH dispatch chokepoints
   * (`daemon/server.ts` here + `mcp/http.ts`) — see capture-push C1. Omitted in
   * tests that don't exercise routed capture; the proxy's no-op defaults apply.
   */
  hostProxyDeps?: Partial<HostProxyDeps>;
  lockNamespace?: PerUserLockNamespace;
}

export type RawRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;
type ShutdownRequestContinuation = () => void | Promise<void>;
type ShutdownRequestHandler = () => Promise<ShutdownRequestContinuation>;

/**
 * What a request represents, for power purposes.
 *
 * - `interaction` — a human or an agent is doing something. Advances the
 *   activity clock and wakes a deep-sleeping daemon.
 * - `probe` — a liveness or readiness check: "are you alive?", "can you serve
 *   yet?". Evidence that the daemon is up, never evidence of work. The
 *   Kubernetes distinction, and the reason a resident MCP bridge polling
 *   `/health` every 5s cannot pin the machine awake.
 * - `passive` — a client that is present but idle, e.g. a dashboard tab left
 *   open on a desk. Served normally; asserts nothing.
 *
 * Only `interaction` touches the power state. `probe` and `passive` differ
 * solely in how they are reported.
 */
export type RequestClass = 'interaction' | 'probe' | 'passive';

/** Header by which a client declares its own activity state. */
const CLIENT_ACTIVITY_HEADER = 'x-myco-client-activity';

/**
 * Endpoints whose entire contract is "am I alive / am I ready / how am I
 * doing". A request here can never mean work, whatever the caller forgot to
 * declare.
 *
 * `/api/power` belongs here for a sharper reason than the other two: it
 * REPORTS the activity clock, so classifying it as interaction made reading
 * the power state reset the value being read — every sample returned
 * `idle_ms: 0`. A monitoring client polling it would also have pinned the
 * daemon awake indefinitely, which is precisely the failure this whole
 * mechanism exists to prevent. Found by live smoke; the unit gates missed it
 * because they exercise the classifier directly and never observe the
 * endpoint's effect on the thing it measures.
 */
const PROBE_PATHS: ReadonlySet<string> = new Set(['/health', '/ready', '/api/power']);

/**
 * Resolve a request's class from what the client declared.
 *
 * Fail-open: an unclassified request counts as `interaction`. The two error
 * directions are not symmetric — a stray poller treated as interaction keeps
 * the daemon awake, which is visible in the power inventory as a named holder,
 * whereas a real client treated as passive loses liveness silently. Silent
 * loss is the failure this mechanism exists to remove.
 *
 * `/health` and `/ready` are unconditionally probes. That is not a route
 * exemption smuggled back in: liveness and readiness are those endpoints'
 * entire contract, they can never signify work, and the backstop means a
 * client that forgets to stamp its keep-alive still degrades to correct
 * behaviour.
 *
 * Pure and exported so the classification contract can be tested directly,
 * without standing up an HTTP server.
 */
export function classifyRequest(
  headers: http.IncomingHttpHeaders,
  pathname: string,
): RequestClass {
  if (PROBE_PATHS.has(pathname)) return 'probe';
  const declared = headers[CLIENT_ACTIVITY_HEADER];
  const value = Array.isArray(declared) ? declared[0] : declared;
  if (value === undefined) return 'interaction';
  if (value === 'probe') return 'probe';
  // The UI reports its own PowerProvider state. Only `active` means a human is
  // actually touching the page; idle/hidden/deep_sleep is a tab left open,
  // which must not hold the machine awake.
  return value === 'active' ? 'interaction' : 'passive';
}

export class DaemonServer {
  port = 0;
  readonly version: string;
  uiDir: string | null;
  uiDevProxyTarget: string | null;
  private server: http.Server | null = null;
  /**
   * The Team Host listener — a SECOND HTTP server bound to a private unix
   * socket, never a TCP port. Null unless host serving is enabled AND the bind
   * succeeds. Every request here passes the transport-boundary gate
   * ({@link handleTeamRequest}) before dispatch.
   */
  private teamServer: http.Server | null = null;
  /** The bound team socket path, or null while unbound. */
  teamSocketPath: string | null = null;
  /** Failed-auth backoff for the team listener. Per-process, global over
   *  failures — the listener answers a unix socket, so there is no per-source
   *  dimension to key on (see `team-host/auth-throttle.ts`). */
  private readonly teamAuthThrottle = createAuthThrottle();
  private readonly teamSocketPathOverride: string | null;
  /**
   * The IPv6-loopback companion listener — the SAME surface as the primary
   * listener, bound to `[::1]` on the same port. It exists so the daemon OWNS
   * its port on both loopback stacks: browsers commonly resolve `localhost` to
   * `::1` first, so a `::1`-only squatter (a stray `ssh -L`, a dev tunnel that
   * lost the IPv4 bind and silently kept the v6 side) would otherwise capture
   * dashboard traffic addressed to this daemon. Null when IPv6 loopback is
   * unavailable, or when the v6 side is already held — which is logged as an
   * error, because it means localhost traffic may already be intercepted.
   */
  private ipv6Server: http.Server | null = null;
  private hostServe: HostServeRuntime | null;
  /** Capture-side proxy deps (transcript-drain flush + collect enqueue) threaded
   *  into `handleAttachedRequest` for attached projects. See {@link DaemonServerConfig}. */
  private hostProxyDeps: Partial<HostProxyDeps>;
  private lockNamespace: PerUserLockNamespace;
  private vaultDir: string;
  private stateAuthority: DaemonStateAuthority;
  private logger: DaemonLogger;
  private router = new Router();
  private rawRoutes = new Map<string, RawRouteHandler>();
  private onRequest: ((requestClass: RequestClass) => void) | null;
  private onRequestContext: ((requestContext: MycoRequestContext, requestClass: RequestClass) => void) | null;
  /**
   * Cooperative-shutdown trigger. Wired late (after the graceful-shutdown
   * closure is built in main.ts) via {@link onShutdownRequest}; a POST to
   * `/api/shutdown` invokes it. This is how a successor daemon or the updater
   * drains THIS daemon on Windows, where a cross-process SIGTERM maps to an
   * uncatchable `TerminateProcess` and the signal-based shutdown never runs.
   */
  private shutdownRequestHandler: ShutdownRequestHandler | null = null;
  private runtimeCache: GroveRuntimeCache;
  private ownsRuntimeCache: boolean;
  /**
   * Daemon-issued bearer token. Generated lazily on first
   * `start()` and re-used for the daemon's lifetime; persisted into
   * `daemon.json` so out-of-band children (manual CLI invocations
   * that didn't inherit the env) can recover it.
   */
  private authToken: string;
  /**
   * The stable `started` timestamp surfaced via currentDaemonState().
   * Initialized in the constructor so the value never changes across
   * calls (the prior `?? new Date().toISOString()` fallback in
   * currentDaemonState fabricated a fresh timestamp on every call when
   * the field was still null, defeating the "stable" invariant).
   * Overwritten once in listen() with the actual listen-time stamp.
   */
  private startedAt: string = new Date().toISOString();
  /**
   * Cache of post-injection dashboard HTML, keyed by source file path.
   * The token is fixed for the daemon's lifetime and the built HTML is
   * immutable, so reading + injecting on every request is wasted work.
   */
  private htmlCache = new Map<string, string>();

  private readonly externalMcpPosture: (() => string) | null;

  constructor(config: DaemonServerConfig) {
    this.vaultDir = config.vaultDir;
    this.logger = config.logger;
    this.externalMcpPosture = config.externalMcpPosture ?? null;
    this.stateAuthority = config.daemonStateAuthority
      ?? createDaemonStateAuthority(
        resolveDaemonServiceState(config.vaultDir, { env: process.env }),
        config.logger,
      );
    this.uiDir = config.uiDir ?? null;
    this.uiDevProxyTarget = config.uiDevProxyTarget ?? null;
    this.onRequest = config.onRequest ?? null;
    this.onRequestContext = config.onRequestContext ?? null;
    this.runtimeCache = config.runtimeCache ?? new GroveRuntimeCache();
    this.ownsRuntimeCache = config.runtimeCache === undefined;
    this.hostServe = config.hostServe ?? null;
    this.teamSocketPathOverride = config.teamSocketPath ?? null;
    this.hostProxyDeps = config.hostProxyDeps ?? {};
    this.lockNamespace = config.lockNamespace ?? nativePerUserLockNamespace;
    this.version = getPluginVersion();
    this.authToken = mintDaemonAuthToken();
    // Export to env so direct children inherit the bearer without
    // having to read daemon.json. Idempotent (mint→export is one
    // pass per daemon process).
    process.env[REQUEST_CONTEXT_AUTH_ENV] = this.authToken;
    this.registerDefaultRoutes();
  }

  /** The bearer token spawned children must present on context-switching headers. */
  getAuthToken(): string {
    return this.authToken;
  }

  /**
   * Live snapshot of what daemon.json *should* contain for this
   * process. Used by `reconcileSelf` to re-assert the state file
   * against the in-memory truth on every PowerManager tick. The
   * `started` field reflects when this daemon began listening, not
   * when the snapshot was taken, so the file's `started` is stable
   * across re-assertions.
   */
  /** Is the overlay (host-serve) listener actually BOUND right now? The
   *  status route's `serving` flag alone is config-derived and survives
   *  every bind failure — this is the observed half of E1 §7 gate 4. */
  isOverlayListenerBound(): boolean {
    return this.teamServer !== null;
  }

  /** Process start stamp (ISO) — the status route's restart discriminator:
   *  an enable job snapshots it pre-restart and Phase 2 requires the
   *  observed value to DIFFER, otherwise the poll can succeed against the
   *  dying pre-restart process (E1 §4.1 rev 6). */
  startedAtIso(): string {
    return this.startedAt;
  }

  currentDaemonState(): DaemonState {
    return {
      pid: process.pid,
      port: this.port,
      // Self-identity record: the file names the RUNNING process (no
      // resolution — see runtime/binary-resolution self-exec-entry).
      command: process.execPath,
      started: this.startedAt,
      sessions: [],
      version: this.version,
      auth_token: this.authToken,
    };
  }

  registerRoute(method: string, routePath: string, handler: RouteHandler): void {
    this.router.add(method, routePath, handler);
  }

  registerRawRoute(routePath: string, handler: RawRouteHandler): void {
    this.rawRoutes.set(routePath, handler);
  }

  /**
   * Wire the cooperative-shutdown handler invoked by `POST /api/shutdown`.
   * Called from main.ts once the graceful-shutdown closure exists. Until then
   * the route reports 503 so a caller falls back to signals.
   */
  onShutdownRequest(handler: ShutdownRequestHandler): void {
    this.shutdownRequestHandler = handler;
  }

  /** Last-resort trace for a transport handler rejection (see start()). */
  private logUnhandledTransportFailure(surface: 'request' | 'upgrade', err: unknown): void {
    try {
      this.logger.error(LOG_KINDS.SERVER_REQUEST, 'Transport handler failed outside its route guard', {
        surface,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? (err.stack ?? null) : null,
      });
    } catch { /* logging best-effort */ }
  }

  async start(port: number = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      // Both handlers run async work that begins BEFORE their internal try
      // blocks (URL parse, route match) — a throw there would otherwise be
      // an unhandled rejection, which exits the process under Bun. Refuse
      // the one request, never the daemon.
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.logUnhandledTransportFailure('request', err);
          try {
            if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal_error' }));
          } catch { /* socket already gone */ }
        });
      });
      this.server.on('upgrade', (req, socket, head) => {
        this.handleUpgrade(req, socket, head).catch((err) => {
          this.logUnhandledTransportFailure('upgrade', err);
          try { socket.destroy(); } catch { /* already destroyed */ }
        });
      });
      this.server.on('error', reject);

      // Tighten Node's default HTTP server limits — see the helper
      // docstring for the load-bearing reasoning. Defaults let a single
      // misbehaving client camp on sockets long enough to exhaust the
      // daemon's fd table.
      applyDaemonHttpServerLimits(this.server);

      this.server.listen(port, '127.0.0.1', HTTP_LISTEN_BACKLOG, () => {
        const addr = this.server!.address() as { port: number };
        this.port = addr.port;
        this.startedAt = new Date().toISOString();
        this.writeDaemonJson();
        this.logger.info(LOG_KINDS.DAEMON_PORT, 'Server started', { port: this.port, dashboard: `http://localhost:${this.port}/` });
        // Claim the port's IPv6-loopback side, then bring up the Team Host
        // listener (if host serving is enabled). Neither ever rejects —
        // a bind failure leaves the loopback daemon fully up on IPv4. Awaited
        // so `start()` resolves with both listeners settled (and, in tests,
        // before either surface is hit).
        this.startLoopbackV6Listener()
          .then(() => this.startTeamListener())
          .then(() => resolve());
      });
    });
  }

  /**
   * Bind the IPv6-loopback companion listener on `[::1]:<port>` — same
   * handlers, same protective limits, same CSRF gate as the primary listener.
   *
   * Owning both loopback stacks is a security property, not a convenience:
   * `localhost` resolves to `::1` before `127.0.0.1` in common browser stacks,
   * so a port bound only on IPv4 leaves its v6 side free for any process to
   * claim and silently receive the user's dashboard traffic — observed in the
   * wild with `ssh -L <port>:...`, which cannot take the held IPv4 side and
   * quietly binds only `::1` instead of failing. With this listener bound, any
   * such claim fails loudly with EADDRINUSE in the squatting tool.
   *
   * Never rejects — the daemon must come up on IPv4 regardless. EADDRINUSE
   * here is logged at error level naming the interception risk (the race is
   * already lost to whoever holds `::1`); an unsupported/unavailable IPv6
   * stack is merely informational, since a browser on such a machine cannot
   * dial `::1` either.
   */
  private startLoopbackV6Listener(): Promise<void> {
    return new Promise((resolve) => {
      // Re-entry guard, same reasoning as the overlay listener's: a second
      // overlapping start must not orphan a bound companion.
      if (this.ipv6Server) { resolve(); return; }

      const v6 = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.logUnhandledTransportFailure('request', err);
          try {
            if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal_error' }));
          } catch { /* socket already gone */ }
        });
      });
      v6.on('upgrade', (req, socket, head) => {
        this.handleUpgrade(req, socket, head).catch((err) => {
          this.logUnhandledTransportFailure('upgrade', err);
          try { socket.destroy(); } catch { /* already destroyed */ }
        });
      });
      applyDaemonHttpServerLimits(v6);

      const onBindError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.logger.error(
            LOG_KINDS.DAEMON_PORT,
            'Another process holds the daemon port on IPv6 loopback — browser traffic to localhost may be routed to IT instead of this daemon. Find and stop it: lsof -nP -iTCP:' + String(this.port) + ' -sTCP:LISTEN',
            { bind_address: '::1', port: this.port, error: err.message },
          );
        } else {
          this.logger.info(LOG_KINDS.DAEMON_PORT, 'IPv6 loopback companion listener not bound — IPv6 loopback unavailable on this machine', {
            bind_address: '::1',
            port: this.port,
            code: err.code ?? null,
            error: err.message,
          });
        }
        try { v6.close(); } catch { /* not listening */ }
        resolve();
      };
      v6.once('error', onBindError);

      v6.listen(this.port, '::1', HTTP_LISTEN_BACKLOG, () => {
        v6.removeListener('error', onBindError);
        // Persistent handler so a post-bind socket error is logged rather than
        // thrown as an unhandled 'error' event (which exits the process).
        v6.on('error', (err) => {
          this.logger.warn(LOG_KINDS.DAEMON_PORT, 'IPv6 loopback companion listener socket error', { error: (err as Error).message });
        });
        this.ipv6Server = v6;
        this.logger.info(LOG_KINDS.DAEMON_PORT, 'IPv6 loopback companion listener bound', { bind_address: '::1', port: this.port });
        resolve();
      });
    });
  }

  /**
   * Bind the Team Host listener on its `AF_UNIX` socket ({@link resolveTeamSocketPath}).
   * Every request on it passes {@link handleTeamRequest}'s transport-boundary
   * gate before dispatch. No-op (and never throws) when host serving is off; a
   * bind failure logs once and leaves host serving off — never a crash.
   *
   * A socket, not a port. The listener this replaces bound a loopback TCP port
   * that a `tailscale serve --tcp` forward bridged to the overlay, which meant
   * the port was reachable by every local process and the gate had to tell
   * members from local callers by comparing a `Host` header string. A socket has
   * no port to squat and no address to spoof — reachability is filesystem
   * permission on a `0700` directory — so the Host comparison is gone and
   * admission rests on the bearer alone.
   *
   * A STALE socket file is reclaimed (a bind onto an existing path fails with
   * EADDRINUSE even when no process holds it), but a LIVE one never is: the
   * connect probe distinguishes them, and failing toward "live" keeps two
   * daemons sharing a home from stealing each other's listener.
   */
  private startTeamListener(): Promise<void> {
    return new Promise((resolve) => {
      // Re-entry guard: a second call while already bound would orphan the
      // still-listening first server so `stop()` could never close it.
      if (this.teamServer) { resolve(); return; }

      const hostServe = this.hostServe;
      if (!hostServe) { resolve(); return; }

      if (process.platform === 'win32') {
        this.logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host serving is not available on Windows — host serving stays off');
        resolve();
        return;
      }

      void (async () => {
        let socketPath: string;
        try {
          // Resolution itself can throw — no short-enough AF_UNIX path exists, or
          // `physicalPathIdentity` hits EACCES/ELOOP walking the home. It has to
          // be inside this try: an escaping throw leaves `start()`'s promise
          // chain unsettled and the daemon never finishes starting, which is a
          // strictly worse outcome than the degraded one this whole block exists
          // to produce ("host serving stays off", daemon up).
          socketPath = this.teamSocketPathOverride ?? resolveTeamSocketPath();
          const dir = path.dirname(socketPath);
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          // The directory is the containment boundary, so refuse to serve from
          // one this user does not own or that anyone else can write. mkdir with
          // `recursive` silently accepts a pre-existing directory — including a
          // symlink another local user planted — so verify rather than assume.
          const dirStat = fs.lstatSync(dir);
          const uid = process.getuid?.() ?? dirStat.uid;
          if (!dirStat.isDirectory() || dirStat.uid !== uid) {
            this.logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host socket directory is not a directory this user owns — host serving stays off', { dir });
            resolve();
            return;
          }
          fs.chmodSync(dir, 0o700);
          if ((fs.lstatSync(dir).mode & 0o077) !== 0) {
            this.logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host socket directory is group/world accessible — host serving stays off', { dir });
            resolve();
            return;
          }
        } catch (err) {
          this.logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host socket could not be prepared — host serving stays off', {
            error: (err as Error).message,
          });
          resolve();
          return;
        }

        const team = http.createServer((req, res) => {
          this.handleTeamRequest(req, res).catch((err) => {
            this.logUnhandledTransportFailure('request', err);
            try {
              if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'internal_error' }));
            } catch { /* socket already gone */ }
          });
        });
        // The team surface carries only daemon↔daemon API traffic — no
        // WebSocket, no Vite dev proxy. Destroy any upgrade attempt outright.
        team.on('upgrade', (_req, socket) => { try { socket.destroy(); } catch { /* already gone */ } });
        applyDaemonHttpServerLimits(team);

        const onBound = () => {
          team.removeListener('error', onBindError);
          // Keep a persistent error handler so a post-bind socket error is
          // logged rather than thrown as an unhandled 'error' event.
          team.on('error', (err) => {
            this.logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host listener socket error', { error: (err as Error).message });
          });
          try { fs.chmodSync(socketPath, 0o600); } catch { /* best-effort; the 0700 dir is the gate */ }
          this.teamServer = team;
          this.teamSocketPath = socketPath;
          this.logger.info(LOG_KINDS.HOST_SERVE, 'Team Host listener bound', { socket: socketPath });
          resolve();
        };

        // BIND FIRST, reclaim only on EADDRINUSE.
        //
        // Probing the path and then unlinking what looks stale is a TOCTOU: two
        // daemons sharing a MYCO_HOME both probe (nothing bound yet), the first
        // binds, and the second unlinks the winner's live inode and binds its
        // own — the listener theft the probe existed to prevent. bind() is the
        // only atomic claim available, so the probe runs only after the kernel
        // has told us something already holds the path.
        //
        // This NARROWS the race rather than closing it: the window between the
        // probe returning "stale" and the unlink is still unguarded, so a third
        // daemon reclaiming in that gap can still have its live inode unlinked.
        // Reaching that needs a stale socket AND two daemons racing the reclaim.
        // The fully atomic shape is bind-to-temp then rename() over the target;
        // not taken here because the remaining window requires a crash to have
        // left a stale socket in the first place.
        let reclaimed = false;
        const onBindError = (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && !reclaimed) {
            reclaimed = true;
            void (async () => {
              if (await socketHasLiveOwner(socketPath)) {
                this.logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host socket has a live owner — host serving stays off', { socket: socketPath });
                try { team.close(); } catch { /* never listened */ }
                resolve();
                return;
              }
              try { fs.unlinkSync(socketPath); } catch { /* raced; the retry reports it */ }
              team.listen(socketPath, HTTP_LISTEN_BACKLOG, onBound);
            })();
            return;
          }
          this.logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host listener failed to bind — host serving stays off', {
            socket: socketPath,
            error: err.message,
            code: err.code ?? null,
          });
          try { team.close(); } catch { /* not listening */ }
          if (this.teamServer === team) this.teamServer = null;
          resolve();
        };
        team.on('error', onBindError);

        team.listen(socketPath, HTTP_LISTEN_BACKLOG, onBound);

      })();
    });
  }


  async stop(): Promise<void> {
    // No daemon.json unlink — see reconcileExistingDaemon for cleanup ownership.
    const team = this.teamServer;
    const teamSocket = this.teamSocketPath;
    // Claim the fields BEFORE any await, so a concurrent stop() sees them
    // already taken and does not close a second time.
    this.teamServer = null;
    this.teamSocketPath = null;
    if (team) {
      await gracefullyCloseHttpServer(team, { gracePeriodMs: SERVER_STOP_FORCE_CLOSE_GRACE_MS });
      // Node removes the socket file on close; sweep defensively so a stale
      // inode never outlives the bind and blocks the next one.
      if (teamSocket) { try { fs.unlinkSync(teamSocket); } catch { /* already gone */ } }
    }
    const v6 = this.ipv6Server;
    this.ipv6Server = null;
    if (v6) {
      await gracefullyCloseHttpServer(v6, { gracePeriodMs: SERVER_STOP_FORCE_CLOSE_GRACE_MS });
    }
    if (!this.server) {
      this.closeRequestDatabases();
      return;
    }
    await gracefullyCloseHttpServer(this.server, {
      gracePeriodMs: SERVER_STOP_FORCE_CLOSE_GRACE_MS,
    });
    this.closeRequestDatabases();
    this.logger.info(LOG_KINDS.DAEMON_START, 'Server stopped');
  }

  /**
   * The Team Host transport-boundary gate — runs on the TEAM listener ONLY,
   * BEFORE raw-route dispatch and BEFORE the router (spec §9). Order:
   *   1. Origin refusal (daemon↔daemon traffic never sets one) + the shared
   *      mutating-body content-type check;
   *   2. blanket bearer — EVERY team request (router, raw, `/mcp`) or 401;
   *   3. raw-route admission — fail closed: a raw route is 404 here unless it is
   *      explicitly admitted, regardless of a valid bearer. Checked AFTER the
   *      bearer so an unauthenticated caller cannot map the admitted set;
   *   4. version window — else 409 `protocol_version_unsupported` (both bounds).
   * On pass, the local daemon bearer is stamped and the request is marked as a
   * team request, then it flows into the SAME dispatch as a localhost request.
   */
  private async handleTeamRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const versionHeader = { 'X-Myco-Api-Version': this.version };
    const hostServe = this.hostServe;
    if (!hostServe) {
      // Unreachable in practice (the team listener only runs when hostServe is
      // set), but fail closed rather than serve unauthenticated.
      this.writeTeamRefusal(res, 503, { error: 'host_serve_unavailable' }, versionHeader);
      return;
    }
    const pathname = new URL(req.url!, 'http://localhost').pathname;

    // (1) Origin refusal + the shared mutating-body content-type check. There is
    // no Host allowlist any more: the listener binds a socket, so there is no
    // port for a local process to reach and no address to compare against. The
    // Origin rule is now load-bearing rather than incidental — it is what keeps
    // a browser from driving this surface cross-origin.
    const csrf = validateTeamRequest(req);
    if (csrf) {
      this.writeTeamRefusal(res, csrf.status, { error: csrf.error }, versionHeader);
      return;
    }

    // (2) Blanket PER-MEMBER token — EXCEPT the ONE enrollment route. A member
    // obtains its token THERE, so gating enrollment behind a token is a
    // chicken-and-egg deadlock; enrollment carries its own gate (a
    // daemon-minted single-use join key) instead. The exemption is surgical
    // (matches only that exact path).
    //
    // A failed attempt is DELAYED before it is answered. Entropy alone was the
    // whole defence while this listener sat behind a tailnet; on a public URL
    // an unbounded stream of failures is work the host performs for a caller
    // who has proven nothing. Success clears the streak, so a working team
    // never waits.
    let member: { id: string; machineId: string } | null = null;
    if (!overlayBearerExempt(pathname)) {
      const auth = teamAuthOutcome(req);
      if (auth.refusal) {
        await delay(this.teamAuthThrottle.noteFailure());
        this.writeTeamRefusal(res, auth.refusal.status, auth.refusal.body, versionHeader, auth.refusal.headers);
        return;
      }
      this.teamAuthThrottle.noteSuccess();
      member = auth.member;
      // Liveness for the operator's member list. Coalesced internally, so this
      // is a read on all but the first request in each window.
      noteMemberSeen(member!.id);

      // (2b) Identity is the TOKEN's, not the caller's header.
      // Present-and-different → refused, never silently overwritten (see
      // `teamMachineIdRejection`).
      const identityRejection = teamMachineIdRejection(req, member!);
      if (identityRejection) {
        this.writeTeamRefusal(res, identityRejection.status, identityRejection.body, versionHeader, identityRejection.headers);
        return;
      }

      // Absent or blank → STAMPED from the token. Without this the header is
      // simply missing downstream, where `resolveRequestContext` falls back to
      // the HOST's own machine id — so omitting the header attributes a
      // member's rows to the host, achieving by default exactly the
      // misattribution the 409 above refuses when it is claimed outright.
      // Unconditional: a matching header makes this a no-op, and the only other
      // case reaching here is absent/blank.
      req.headers[REQUEST_CONTEXT_HEADERS.machineId] = member!.machineId;
    }

    // (3) RAW-ROUTE ADMISSION — fail closed. Raw routes bypass the router and
    // therefore `classifyRouteStamp` entirely, so they get no scope-map class
    // and no `overlayHostStampRefusal` backstop. On a surface published to the
    // public internet the default must be refusal: a raw route is unreachable
    // here unless it is named in the admitted set. This replaces a deny-list
    // that named only `/api/shutdown`, under which every raw route added later
    // was served to members by default.
    //
    // Ordered AFTER the bearer deliberately. Refusing first would answer an
    // unauthenticated caller 404-vs-401 by route, handing anyone who can reach
    // the socket a map of which raw routes this host admits. Behind the bearer,
    // every route answers 401 to a caller without one.
    if (this.rawRoutes.has(pathname) && !teamRawRouteAdmitted(pathname)) {
      this.writeTeamRefusal(res, 404, { error: 'not_found', message: 'This route is served on localhost only.' }, versionHeader);
      return;
    }

    // (4) Version window.
    const versionRejection = overlayVersionRejection(req);
    if (versionRejection) {
      this.writeTeamRefusal(res, versionRejection.status, versionRejection.body, versionHeader, versionRejection.headers);
      return;
    }

    // Gate passed. The host bearer proved admission (flat trust, spec §9). Stamp
    // the LOCAL daemon bearer — the member's proxy stripped `x-myco-auth`, and the
    // host's downstream tenancy resolver requires it on context-switching headers —
    // so the host-resident Grove resolves exactly as a local context-switch would.
    // Tenancy headers (project/grove/machine) remain claims, per v1's flat trust.
    req.headers[REQUEST_CONTEXT_AUTH_HEADER] = this.authToken;
    markTeamRequest(req);
    await this.handleRequest(req, res);
  }

  private writeTeamRefusal(
    res: http.ServerResponse,
    status: number,
    body: Record<string, unknown>,
    versionHeader: Record<string, string>,
    extraHeaders?: Record<string, string>,
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...versionHeader, ...(extraHeaders ?? {}) });
    res.end(JSON.stringify(body));
  }

  /**
   * The listener-appropriate CSRF gate. Overlay requests were fully validated by
   * {@link handleTeamRequest} (bearer, version, lifecycle refusal, and the
   * overlay Host/Origin gate) before delegating here, so they skip the loopback
   * gate; loopback requests get {@link validateLoopbackRequest} unchanged.
   */
  private csrfRejection(req: http.IncomingMessage): Rejection | null {
    return isTeamRequest(req) ? null : validateLoopbackRequest(req, this.port);
  }

  private registerDefaultRoutes(): void {
    // /health and /api/version are liveness probes. They must answer
    // within milliseconds regardless of background-job state. Routing
    // them through the normal router pulls them through CSRF validation,
    // manifest-driven request-context resolution, GroveRuntimeCache DB
    // opens, and `withDatabase()` AsyncLocalStorage wrapping — any of
    // which can stall when a background job (e.g. embedding reconcile
    // against a wedged Ollama) is holding the event loop on synchronous
    // bun:sqlite work or DB-open contention.
    //
    // Live dogfood reproduction: Ollama wedged → reconcile loop ran
    // embed() against a hung TCP socket; daemon's TCP listener kept
    // accepting connections but /health timed out at 3+ seconds with
    // HTTP 000. The route handlers themselves are trivial (pid/uptime
    // from memory) — the cost lived entirely in the request pipeline.
    //
    // Raw routes bypass that pipeline. They still pass loopback CSRF
    // validation (so a cross-origin POST can't hit them) but read no
    // disk, open no DB, and acquire no AsyncLocalStorage scope.
    const versionHeader = { 'X-Myco-Api-Version': this.version };
    this.registerRawRoute('/health', async (req, res) => {
      // GET-only — POST/PUT/DELETE on /health is nonsense.
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...versionHeader });
      // NARROWED on the team surface. This route is admitted to
      // `TEAM_ADMITTED_RAW_ROUTES` so a member can confirm its host answers —
      // and a member needs the status code, nothing else. The local body
      // carries operator diagnostics (this machine's pid and uptime, and its
      // external-MCP posture, which has nothing to do with team membership);
      // handing those to every bearer holder over the public internet is
      // disclosure with no consumer. `myco` + `version` is what a reachability
      // check reads.
      res.end(JSON.stringify(isTeamRequest(req)
        ? { myco: true, version: this.version }
        : {
          myco: true,
          version: this.version,
          external_mcp_activation: this.externalMcpPosture?.() ?? EXTERNAL_MCP_ACTIVATION_POSTURE,
          pid: process.pid,
          uptime: process.uptime(),
        }));
    });
    this.registerRawRoute('/api/version', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...versionHeader });
      res.end(JSON.stringify({ version: this.version }));
    });
    // Cooperative shutdown: a successor daemon or the updater POSTs here to run
    // THIS daemon's graceful drain (in-flight runs, team-sync outbox, DB close)
    // and exit on its own. The ONLY graceful path on Windows, where a
    // cross-process SIGTERM is an uncatchable TerminateProcess. POST-only — it
    // mutates daemon lifecycle; loopback CSRF is already enforced upstream.
    this.registerRawRoute('/api/shutdown', async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      const handler = this.shutdownRequestHandler;
      if (!handler) {
        // Briefly true between listen() and main.ts wiring the closure.
        res.writeHead(503, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'shutdown_not_ready' }));
        return;
      }
      let continueShutdown: ShutdownRequestContinuation;
      try {
        continueShutdown = await handler();
      } catch {
        res.writeHead(409, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'shutdown_blocked' }));
        return;
      }
      res.writeHead(202, { 'Content-Type': 'application/json', ...versionHeader });
      res.end(JSON.stringify({ myco: true, shutting_down: true }), () => {
        void Promise.resolve(continueShutdown()).catch((error) => {
          this.logger.error(LOG_KINDS.DAEMON_START, 'Prepared shutdown continuation failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    });

    // Team Host enrollment — the ONE team route exempt from the per-member
    // token gate, because a member obtains its token HERE. The exemption is
    // surgical, and it is only safe because the route carries its OWN gate: a
    // daemon-minted single-use join key, in the request, that this daemon
    // validates. That is a genuinely new gate rather than a port — the
    // overlay-era key was a headscale pre-auth key consumed by the member's
    // `tailscale up`, which this daemon never saw, and the real admission
    // boundary was tailnet membership. With no tailnet, publishing this route
    // without the key check would hand a credential to anyone who asked.
    this.registerRawRoute(HOST_ENROLL_ROUTE, async (req, res) => {
      // TEAM-LISTENER-ONLY. The localhost surface has no business enrolling
      // anyone, and answering there would make the operator's own dashboard an
      // enrollment endpoint.
      if (!isTeamRequest(req)) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'not_found', message: 'Host enrollment is served to team members only.' }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      const hostServe = this.hostServe;
      if (!hostServe) {
        // Unreachable when serving (the team listener only runs with hostServe
        // set), but fail closed rather than 500.
        res.writeHead(503, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'host_serve_unavailable' }));
        return;
      }

      // `JSON.parse` yields `null` for the body `null`, and a bare `null`
      // survives the cast — so normalise to `{}` rather than letting the field
      // reads below throw. An uncaught throw here escapes as a 500, which both
      // distinguishes this shape from every other malformed one (the route
      // stops being uniform) and skips the throttle entirely, leaving a free
      // un-metered probe.
      let parsed: unknown;
      try { parsed = await readBody(req); } catch { /* refused below */ }
      const body: Record<string, unknown> = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};

      const presentedKey = typeof body.key === 'string' ? body.key.trim() : '';
      const machineId = typeof body.machine_id === 'string' ? body.machine_id.trim() : '';
      // Validated with the SAME rule the path resolvers enforce downstream
      // (`isSafeCaptureSegment`), at the boundary where it is first believed
      // rather than at the point it would escape a directory. A `machine_id` is
      // `{user}_{hash}`; anything with separators, `..`, control characters, or
      // unbounded length is not one, and storing it verbatim would put it in the
      // operator's roster and the action log.
      const machineIdUsable = isSafeCaptureSegment(machineId) && machineId.length <= MAX_MACHINE_ID_LENGTH;
      if (!presentedKey || !machineIdUsable) {
        // Same 401 shape as a bad key: a caller must not learn from the
        // response whether it got the FORM right, only whether it got in.
        await delay(this.teamAuthThrottle.noteFailure());
        res.writeHead(401, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'enrollment_unauthorized', message: 'Enrollment requires a valid one-time join key.' }));
        return;
      }

      // Validated AND consumed in one operation — see `consumeJoinKey`. The
      // specific rejection reason is deliberately not echoed: valid-but-expired
      // and never-existed answer identically, so the route is not an oracle for
      // which keys were ever real.
      const check = consumeJoinKey(presentedKey, { machineId });
      if (!check.ok) {
        await delay(this.teamAuthThrottle.noteFailure());
        this.logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host enrollment refused', { reason: check.reason });
        res.writeHead(401, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'enrollment_unauthorized', message: 'Enrollment requires a valid one-time join key.' }));
        return;
      }
      this.teamAuthThrottle.noteSuccess();

      // The key is spent; issue this member's own token, bound to the
      // machine_id it just asserted. That binding is the trust-on-first-use
      // anchor every later request is checked against.
      let issued: IssuedMemberToken;
      try {
        issued = issueMemberToken(machineId, {
          label: typeof body.member_hostname === 'string' ? body.member_hostname : undefined,
        });
      } catch (error) {
        if (!(error instanceof MemberAlreadyEnrolledError)) throw error;
        // A DISTINCT status from the 401s above, deliberately: this caller
        // presented a genuinely valid key, so the uniform-refusal reasoning
        // (do not reveal whether a key was ever real) does not apply, and
        // telling the operator "revoke it first" is the whole point.
        this.logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host enrollment refused', { reason: 'machine_already_enrolled' });
        res.writeHead(409, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({
          error: 'machine_already_enrolled',
          message: 'That machine already has access to this host. Revoke its current access first, then join again.',
        }));
        return;
      }

      const payload = buildHostEnrollmentPayload(hostServe, issued.token);
      const enrollmentNonce = body.enrollment_nonce;
      const responsePayload = typeof enrollmentNonce === 'string'
        && /^[a-f0-9]{32,}$/.test(enrollmentNonce)
        ? {
          ...payload,
          enrollment_receipt: {
            enrollment_nonce: enrollmentNonce,
            host_id: payload.host_id,
            protocol_version: payload.protocol_version,
          },
        }
        : payload;
      res.writeHead(200, { 'Content-Type': 'application/json', ...versionHeader });
      res.end(JSON.stringify(responsePayload));

      const memberInfo: Record<string, unknown> = { ...body, key: undefined };

      // Record the join for the operator's diagnosable safety net (spec §9). The
      // subject is the member's overlay IP off the CONNECTION (unspoofable), with the
      // self-reported hostname as detail. NEVER logs the bearer. Best-effort.
      try {
        appendHostAction({
          action: 'enroll',
          subject: req.socket.remoteAddress ?? (memberInfo.member_overlay_ip as string | undefined),
          detail: {
            member_hostname: memberInfo.member_hostname,
            member_overlay_ip: memberInfo.member_overlay_ip,
          },
        });
      } catch { /* the log is a diagnostic aid, not the trust boundary */ }
    });

    // Readiness deliberately uses the normal route pipeline. /health answers
    // "is the process alive?"; /ready answers "can routed daemon requests
    // make it through request-context resolution and DB scoping?"
    this.registerRoute('GET', '/ready', async () => ({
      body: {
        myco: true,
        ready: true,
        version: this.version,
        pid: process.pid,
        uptime: process.uptime(),
      },
    }));
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = new URL(req.url!, 'http://localhost').pathname;
    const rawHandler = this.rawRoutes.get(pathname);
    if (rawHandler) {
      const rejection = this.csrfRejection(req);
      if (rejection) {
        res.writeHead(rejection.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: rejection.error }));
        return;
      }
      this.onRequest?.(classifyRequest(req.headers, pathname));
      try {
        await rawHandler(req, res);
      } catch (error) {
        this.logger.error(LOG_KINDS.SERVER_ERROR, 'Raw request handler error', {
          path: req.url,
          error: (error as Error).message,
        });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }));
        }
      }
      return;
    }

    // API/daemon routes take priority over static files
    const match = this.router.match(req.method!, req.url!);

    if (match) {
      // CSRF defense: the daemon listens only on 127.0.0.1 but any web page
      // the user visits can still POST cross-origin. Reject requests whose
      // Host or Origin headers disagree with the loopback listener; block
      // non-JSON mutating bodies so text/plain CSRF cannot slip JSON through.
      // (Overlay requests were already gated by handleTeamRequest — see
      // csrfRejection.)
      const rejection = this.csrfRejection(req);
      if (rejection) {
        res.writeHead(rejection.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: rejection.error }));
        return;
      }

      this.onRequest?.(classifyRequest(req.headers, pathname));
      const versionHeader = { 'X-Myco-Api-Version': this.version };
      try {
        // Team Host HOST-side overlay backstop: a request that arrived on this
        // daemon's overlay listener is served LOCALLY (the host answers for its own
        // Grove) and is never re-classified/re-proxied — the anti-circularity
        // guarantee the skip below protects. But v1 is flat-trust (design §9): the
        // shared bearer proves admission, not identity, and the member-side
        // classifyRoute is the MEMBER's gate — a hostile member can craft a raw
        // overlay request that never ran it. So the host independently enforces the
        // scope-map stamp on the matched route (match.pathname, so :param routes
        // classify correctly), refusing the classes that must never be overlay-served
        // (localhost-only operator/secret routes, degraded capabilities, and
        // host-authoritative/member-assembled config) BEFORE the route is served.
        // serve/collect fall through to local dispatch, so this only ADDS refusals —
        // it never enters the remote/proxy branch.
        if (isTeamRequest(req)) {
          const overlayRefusal = overlayHostStampRefusal(req.method!, match.pathname);
          if (overlayRefusal) {
            this.writeRefusal(res, overlayRefusal, versionHeader);
            return;
          }
          // Team Host registration-on-ingest (E-4 W2 T1a): a served project
          // becomes real on its first FORWARDED capture — the host-side mirror
          // of the local hook's ensureProjectRegistered. Runs PRE-resolution so
          // the very collect request that triggers it then resolves against the
          // freshly-written registry row (the served-grove filter and normal
          // resolution below are unchanged). Gated inside the helper; a gate
          // miss is byte-identical to today.
          this.registerHostedProjectOnIngest(req.method!, match.pathname, req.headers);
        }

        // Team Host member-side chokepoint: an attached project is served by a
        // remote host daemon, so the member's dispatch routes it over the overlay.
        // A request that ARRIVED on this daemon's overlay listener has already been
        // routed to its host (this daemon) — it must be served LOCALLY and never
        // re-classified/re-proxied. Skipping attach classification for overlay
        // requests makes a circular proxy structurally impossible regardless of
        // registry contents. (It is also impossible by construction: a host serving
        // a Grove has that Grove's projects as LOCAL registry rows, and attachProject
        // refuses to attach a project with a local Grove row — ProjectRegisteredLocallyError
        // — so resolveAttach can never match a host's own served project.)
        if (!isTeamRequest(req)) {
          // Resolve tenancy cheaply and route BEFORE the body is read and BEFORE any
          // local Grove/DB resolution — the proxy pipes the raw request stream, and
          // an attached project must never open a local Grove DB. A non-attached
          // project (the common case) returns `local` after a single empty-set
          // registry probe, so the path below is byte-identical.
          // E1 §5.3: the EXPLICIT destination-host carrier. A member's Team
          // page addresses a HOST, not a project — the old attach-ref-as-
          // carrier scheme left a joined host with zero attached projects
          // silently unconfigurable (no ref → classifyRoute short-circuits
          // to local). Browser-only by design: `mcp/http.ts` never honors
          // this header. Admitted ONLY for team-write stamps — every other
          // class either answers locally (localhost-only) or has no
          // legitimate host-carrier caller (serve/collect are project-
          // scoped; config-carve is member-assembled).
          const carrierHostId = readHeader(req.headers, REQUEST_CONTEXT_HEADERS.hostId);
          if (carrierHostId) {
            // The header selects which remote machine receives the write —
            // a strictly MORE powerful context switch than grove/project —
            // so it sits behind the same daemon-bearer gate (throws → 401).
            enforceContextSwitchAuth(req.headers, this.authToken);
            const carrierClassification = classifyRouteStamp(req.method!, match.pathname);
            if (carrierClassification.stamp === 'team-write') {
              const resolved = resolveHostCarrierTarget(carrierHostId, this.lockNamespace);
              if (resolved.kind === 'refusal') {
                this.writeRefusal(res, resolved.refusal, versionHeader);
                return;
              }
              await handleAttachedRequest(req, res, resolved.target, carrierClassification, {
                ...this.hostProxyDeps,
                logger: proxyLoggerFrom(this.logger, LOG_KINDS.SERVER_ERROR),
              });
              return;
            }
          }
          const inboundProjectId = this.inboundProjectId(match.params, req.headers);
          const decision = classifyRoute({
            method: req.method!,
            pathname: match.pathname,
            projectId: inboundProjectId,
          }, this.lockNamespace);
          if (decision.kind === 'degraded' || decision.kind === 'config_locked') {
            this.writeRefusal(res, decision.refusal, versionHeader);
            return;
          }
          if (decision.kind === 'remote') {
            // URL-tenancy resource routes assert the (Grove, project) in the path,
            // so the daemon bearer is required unconditionally — the same gate the
            // local resolver (requestContextFromTenancyIds) runs, applied here
            // BEFORE any proxy dial so an attached resource route can't skip it
            // (closes the URL-route auth deviation Task 1.2 documented). Throws
            // UnauthorizedRequestContextError → the existing catch maps it to 401.
            if (match.params.projectId) {
              enforceUrlTenancyAuth(req.headers, this.authToken);
            }
            await handleAttachedRequest(req, res, decision.target, decision.classification, {
              ...this.hostProxyDeps,
              logger: proxyLoggerFrom(this.logger, LOG_KINDS.SERVER_ERROR),
            });
            return;
          }
          if (decision.kind === 'config_carve') {
            // An attached project's config is carved by tier, member-side: machine/
            // project/personal resolve from the member's own disk, the grove tier is
            // host-sourced, and a personal override of a grove-tier leaf is refused
            // (routing-layer §6.3). Neither a proxy nor the local resolver is correct
            // here (§6.3, §1.1) — the member assembles. The scoped PUT needs its body.
            const carveBody = isWriteMethod(req.method) ? await readBody(req) : undefined;
            await handleAttachedConfigRequest(req, res, match.pathname, decision.attach, decision.target, carveBody, {
              dial: defaultDial,
              logger: proxyLoggerFrom(this.logger, LOG_KINDS.SERVER_ERROR),
              lockNamespace: this.lockNamespace,
            });
            return;
          }
        }

        const needsBody = isWriteMethod(req.method);
        const body = needsBody ? await readBody(req) : undefined;
        // Stamp overlay-origin onto the resolved context from the spoofing-proof
        // overlay mark (a WeakSet keyed on the request object, not a header). A
        // host-served-for-a-member run carries this to the executor's tool surface
        // so committed-file publishes / project-tree reads never touch a member
        // working tree the host lacks. False for every local (loopback) request.
        const requestContext = {
          ...this.resolveRouteRequestContext(match.params, req.headers),
          hostServed: isTeamRequest(req),
        };
        // Team Host served-grove filter (Task 2), chokepoint 1 of 2 (see
        // `mcp/http.ts` for chokepoint 2). The bearer/lifecycle/version gate
        // above proves overlay ADMISSION only — it says nothing about WHICH
        // Grove a member may reach. Without this, a bearer-holding member
        // could send `x-myco-grove-id` naming ANY Grove this host owns,
        // including the operator's own personal Groves. Runs immediately
        // after the Grove context resolves, before any handler/DB touch.
        if (isTeamRequest(req)) {
          const groveRefusal = this.hostServe
            ? servedGroveRefusal(this.hostServe, requestContext.groveId)
            // Unreachable in practice (the overlay listener — and hence
            // isTeamRequest — only marks requests when hostServe is set),
            // but fail closed exactly like handleTeamRequest's own
            // null-hostServe branch, never serve unauthenticated.
            : { status: 503, body: { error: 'host_serve_unavailable' } };
          if (groveRefusal) {
            // Logged (throttled) — chokepoint 1 of 2 (see mcp/http.ts for
            // chokepoint 2). T1's C2 fix removed the biggest legitimate
            // source of null-grove refusals, so a remaining one is genuinely
            // anomalous and worth an operator's attention; throttled for the
            // same capture-drain-retry reason as the unknown-tenancy warn
            // above (Task 2, E-4 W2).
            const resolvedGroveId = requestContext.groveId;
            const servedGroveId = this.hostServe?.servedGroveId ?? null;
            const throttleKey = `served_grove:${pathname}:${resolvedGroveId ?? ''}:${servedGroveId ?? ''}`;
            if (shouldLogOncePerInterval(throttleKey, REFUSAL_LOG_THROTTLE_INTERVAL_MS)) {
              this.logger.warn(LOG_KINDS.HOST_SERVE_REFUSAL, 'Refused overlay request outside the served Grove', {
                path: pathname,
                resolved_grove_id: resolvedGroveId,
                served_grove_id: servedGroveId,
              });
            }
            this.writeTeamRefusal(res, groveRefusal.status, groveRefusal.body, versionHeader, groveRefusal.headers);
            return;
          }
        }
        // Long-running ops (move, vacuum) take a per-project pause in
        // `projects.toml`; while set, every writer for that project must
        // be refused. Reads stay open so the UI can still surface "this
        // project is paused (reason)". One owner-op-scoped exception: the
        // move endpoint itself passes a 'grove-move' pause, because the
        // retry that resumes a crash-orphaned move (releasing or re-taking
        // its own pause) arrives through this very gate.
        if (isWriteMethod(req.method) && requestContext.groveId && requestContext.projectId) {
          const projectId = requestContext.projectId;
          const paused = isProjectPaused(projectId);
          if (
            paused.paused
            && !isMoveRetryRequest(req.method, match.pathname, match.params, paused.reason, projectId)
          ) {
            const response = pausedErrorResponse(projectId, paused);
            res.writeHead(response.status, { 'Content-Type': 'application/json', ...versionHeader });
            res.end(JSON.stringify(response.body));
            return;
          }
        }
        // Per-project counterpart of the global wake edge. The `onRequest`
        // seam fires before routing and so is context-free; this is the one
        // place the owning Grove and project are resolved, which is why the
        // per-project signal does not need touching at every call site.
        if (this.onRequestContext) {
          this.onRequestContext(requestContext, classifyRequest(req.headers, pathname));
        }
        const invokeHandler = () => match.handler({
          body,
          query: match.query,
          params: match.params,
          pathname: match.pathname,
          headers: req.headers,
          requestContext,
          isOverlay: isTeamRequest(req),
        });
        const requestDb = this.databaseForRequestContext(requestContext);
        const result = requestDb
          ? await withDatabase(requestDb, invokeHandler)
          : await invokeHandler();
        const status = result.status ?? DEFAULT_STATUS;
        if (Buffer.isBuffer(result.body)) {
          res.writeHead(status, { ...versionHeader, ...result.headers });
          res.end(result.body);
          return;
        }
        const headers = { 'Content-Type': 'application/json', ...versionHeader, ...result.headers };
        res.writeHead(status, headers);
        res.end(JSON.stringify(result.body));
      } catch (error) {
        if (error instanceof RequestBodyTooLarge) {
          res.writeHead(413, { 'Content-Type': 'application/json', ...versionHeader });
          res.end(JSON.stringify({ error: 'request_body_too_large', limit_bytes: MAX_REQUEST_BODY_BYTES }));
          return;
        }
        if (error instanceof UnauthorizedRequestContextError) {
          // G4: caller passed context-switching headers without the
          // daemon-issued bearer token. Refuse before any handler runs.
          res.writeHead(401, { 'Content-Type': 'application/json', ...versionHeader });
          res.end(JSON.stringify({ error: 'unauthorized_context_switch', message: error.message }));
          return;
        }
        if (error instanceof UnknownRequestContextError) {
          // Stale/guessed Grove or project id (e.g. in a resource URL): the
          // requested tenancy doesn't exist. 404, not a 500 server error.
          //
          // Logged (throttled) ONLY over the overlay: a loopback caller's
          // hook/dashboard sees this 404 body directly, but a member's proxy
          // relay hides it from the operator entirely — this warn is the
          // only host-side trace of a member naming Grove/project tenancy
          // this host has never heard of. Throttled because a member's
          // capture-drain retry reissues the identical refused request every
          // daemon tick; an unthrottled warn here would be a log storm, not
          // observability (Task 2, E-4 W2).
          if (isTeamRequest(req)) {
            const groveHeaderValue = readHeader(req.headers, REQUEST_CONTEXT_HEADERS.groveId);
            const projectHeaderValue = readHeader(req.headers, REQUEST_CONTEXT_HEADERS.projectId);
            const throttleKey = `unknown_tenancy:${groveHeaderValue ?? ''}:${projectHeaderValue ?? ''}:${pathname}`;
            if (shouldLogOncePerInterval(throttleKey, REFUSAL_LOG_THROTTLE_INTERVAL_MS)) {
              this.logger.warn(LOG_KINDS.HOST_SERVE_REFUSAL, 'Refused overlay request for unknown tenancy', {
                path: req.url,
                grove_header: groveHeaderValue ?? null,
                project_header: projectHeaderValue ?? null,
              });
            }
          }
          res.writeHead(404, { 'Content-Type': 'application/json', ...versionHeader });
          res.end(JSON.stringify({ error: 'unknown_tenancy', message: error.message }));
          return;
        }
        if (error instanceof ForeignGroveError) {
          // The request resolved to a Grove that lives in another daemon's
          // home (`<MYCO_HOME>/groves/`). Refuse before any handler (or DB
          // open) runs. Logged at warn: hook clients swallow 403s silently,
          // so this line is the only daemon-side trace.
          this.logger.warn(LOG_KINDS.SERVER_ERROR, 'Refused request for foreign-home Grove', {
            path: req.url,
            grove_id: error.groveId,
          });
          res.writeHead(403, { 'Content-Type': 'application/json', ...versionHeader });
          res.end(JSON.stringify({
            error: 'foreign_grove',
            message: error.message,
            grove_id: error.groveId,
          }));
          return;
        }
        if (error instanceof UnknownGroveError) {
          // A caller-named Grove id (body scope / URL :id) with no record
          // on this machine: 404 before any groves/<id>/ path is created.
          res.writeHead(404, { 'Content-Type': 'application/json', ...versionHeader });
          res.end(JSON.stringify({
            error: 'grove_not_found',
            message: error.message,
            grove_id: error.groveId,
          }));
          return;
        }
        if (error instanceof SchemaVersionTooNewError || error instanceof PreMigrationCheckpointError) {
          // The request's Grove refused to open: its vault was written by a
          // newer binary (rollback residue), or its pre-migration checkpoint
          // failed so the migration was aborted. Per-Grove and per-request —
          // nothing broken is cached and the daemon keeps serving every other
          // Grove. 503 because the state is operator-repairable (upgrade the
          // binary / clear the backup failure), not a client error.
          this.logger.error(LOG_KINDS.SERVER_ERROR, 'Grove refused to open', {
            path: req.url,
            code: error.code,
            error: error.message,
          });
          res.writeHead(503, { 'Content-Type': 'application/json', ...versionHeader });
          res.end(JSON.stringify(errorBody(error.code, error.message)));
          return;
        }
        this.logger.error(LOG_KINDS.SERVER_ERROR, 'Request handler error', {
          path: req.url,
          error: (error as Error).message,
        });
        res.writeHead(500, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }

    if (isDaemonControlPath(pathname)) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'X-Myco-Api-Version': this.version });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    // The overlay carries only the daemon API (spec §9 — the host UI stays a
    // localhost-only operator surface; no browsers on the overlay). An overlay
    // request that matched no API route (static asset, dashboard SPA, dev proxy)
    // is never served — 404 before the UI/static/dev-proxy fallthrough below.
    if (isTeamRequest(req)) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'X-Myco-Api-Version': this.version });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    // No API route matched — proxy to Vite dev server when configured.
    if (this.uiDevProxyTarget && req.method === 'GET') {
      const proxied = await this.proxyUiDevRequest(req, res);
      if (proxied) return;
    }

    // No API route matched — serve static files (dashboard SPA). Disk is
    // preferred so dev/npm live UI rebuilds are picked up without recompiling.
    if (this.uiDir && req.method === 'GET') {
      const result = resolveStaticFile(this.uiDir, pathname);
      if (result) {
        try {
          if (result.contentType === 'text/html') {
            let injected = this.htmlCache.get(result.filePath);
            if (injected === undefined) {
              const raw = await fs.promises.readFile(result.filePath, 'utf-8');
              injected = injectDashboardBootstrap(raw, this.authToken);
              this.htmlCache.set(result.filePath, injected);
            }
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': result.cacheControl,
            });
            res.end(injected);
          } else {
            const content = await fs.promises.readFile(result.filePath);
            res.writeHead(200, {
              'Content-Type': result.contentType,
              'Cache-Control': result.cacheControl,
            });
            res.end(content);
          }
        } catch {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        }
        return;
      }
    }

    // No disk dist/ui (standalone binary) — serve the UI bundle compiled into
    // the binary.
    if (req.method === 'GET') {
      const embedded = resolveEmbeddedAsset(pathname);
      if (embedded) {
        if (embedded.contentType === 'text/html') {
          const cacheKey = `embedded:${pathname}`;
          let injected = this.htmlCache.get(cacheKey);
          if (injected === undefined) {
            injected = injectDashboardBootstrap(embedded.body.toString('utf-8'), this.authToken);
            this.htmlCache.set(cacheKey, injected);
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': embedded.cacheControl,
          });
          res.end(injected);
        } else {
          res.writeHead(200, {
            'Content-Type': embedded.contentType,
            'Cache-Control': embedded.cacheControl,
          });
          res.end(embedded.body);
        }
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  private async proxyUiDevRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (!this.uiDevProxyTarget || !req.url) return false;

    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (isDaemonControlPath(pathname)) return false;

    try {
      const targetUrl = new URL(req.url, this.uiDevProxyTarget).toString();
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value || key === 'host' || key === 'connection' || key === 'content-length') continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else {
          headers.set(key, value);
        }
      }

      const response = await fetch(targetUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
      });

      const responseHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of response.headers.entries()) {
        if (key === 'connection' || key === 'content-length' || key === 'transfer-encoding') continue;
        responseHeaders[key] = value;
      }

      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, responseHeaders);
      res.end(body);
      return true;
    } catch (error) {
      this.logger.warn(LOG_KINDS.SERVER_ERROR, 'UI dev proxy request failed', {
        path: req.url,
        target: this.uiDevProxyTarget,
        error: (error as Error).message,
      });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ui_dev_proxy_failed' }));
      return true;
    }
  }

  /**
   * Resolve the request context for a matched route. Resource routes that
   * browsers load directly (`<img>`/`<video>`/file downloads via the
   * `/api/g/:groveId/p/:projectId/...` prefix) cannot attach the `x-myco-*`
   * tenancy headers the scripted API uses, so they carry (Grove, project) in
   * the URL path. When both params are present, resolve tenancy from the URL;
   * otherwise fall back to the header-based resolver. No existing route
   * declares both `:groveId` and `:projectId`, so this only engages for the
   * new URL-scoped resource routes.
   */
  private resolveRouteRequestContext(
    params: Record<string, string>,
    headers: http.IncomingMessage['headers'],
  ): MycoRequestContext {
    if (params.groveId && params.projectId) {
      return requestContextFromTenancyIds(
        { groveId: params.groveId, projectId: params.projectId },
        this.vaultDir,
        { headers, expectedAuthToken: this.authToken, enforceGroveOwnership: true },
      );
    }
    return requestContextFromHttpHeaders(headers, this.vaultDir, {
      expectedAuthToken: this.authToken,
      // Inbound daemon resolution: a request must never resolve to (and
      // then open) a Grove served by the other daemon variant.
      enforceGroveOwnership: true,
      // Member local dispatch: a `localhost-only` route classified `local`
      // for an ATTACHED project (the member's active UI selection) carries
      // (localGroveId, attachedProjectId) but has no local Grove row. Tolerate
      // it into a display-only, grove-scoped context so machine-scoped surfaces
      // serve instead of 404ing. Only this member-dispatch seam sets it; the
      // `/mcp` transport, external listener, and URL tenancy leave it off.
      tolerateAttachedProject: true,
      lockNamespace: this.lockNamespace,
    });
  }

  /**
   * Effective project id for the Team Host routing chokepoint, resolved without
   * any Grove/DB lookup. Any route that names the project in the path identifies
   * the attach target directly — the resource routes (`:projectId` alongside
   * `:groveId`) and the grove-lifecycle routes (`:projectId` alongside `:id`),
   * so we key on `params.projectId` regardless of the grove param's name.
   * Everything else goes through the header/manifest pre-parse (which also runs
   * the local bearer gate exactly as the full resolver does). A malformed id
   * resolves to null so the request falls through to today's local resolver,
   * which reports the error exactly as before.
   */
  private inboundProjectId(
    params: Record<string, string>,
    headers: http.IncomingMessage['headers'],
  ): GroveProjectId | null {
    if (params.projectId) {
      return isGroveEraId(params.projectId, 'project') ? (params.projectId as GroveProjectId) : null;
    }
    return resolveInboundProjectId(headers, this.vaultDir, { expectedAuthToken: this.authToken }).projectId;
  }

  /**
   * The single writer for a Team Host degradation refusal on a router route
   * (`classifyRoute` → `degraded` / `config_locked`). One uniform payload,
   * serialized by `refusalJson`; the `/mcp` chokepoint renders the same payload
   * through `refusalMcpBody`.
   */
  private writeRefusal(
    res: http.ServerResponse,
    payload: RefusalPayload,
    versionHeader: Record<string, string>,
  ): void {
    const { status, body } = refusalJson(payload);
    res.writeHead(status, { 'Content-Type': 'application/json', ...versionHeader });
    res.end(JSON.stringify(body));
  }

  /**
   * Team Host registration-on-ingest seam (E-4 W2 T1a). Called for every
   * overlay collect route BEFORE resolution; the gate lives in
   * `maybeRegisterHostedProjectOnIngest`. Emits the one structured line on a
   * fresh registration (project id, grove, route), and a warn on a registration
   * that threw (self-heals on the next forwarded capture — resolution just 404s
   * meanwhile, exactly as today). Never throws into dispatch.
   */
  private registerHostedProjectOnIngest(
    method: string,
    pathname: string,
    headers: http.IncomingMessage['headers'],
  ): void {
    const outcome = maybeRegisterHostedProjectOnIngest({
      method,
      pathname,
      headers,
      servedGroveId: this.hostServe?.servedGroveId ?? null,
    });
    if (outcome.registered) {
      this.logger.info(LOG_KINDS.HOSTED_PROJECT_REGISTER, 'Registered hosted project on first forwarded capture', {
        project_id: outcome.projectId,
        grove_id: outcome.groveId,
        route: `${method} ${pathname}`,
      });
    } else if (outcome.error) {
      this.logger.warn(LOG_KINDS.HOSTED_PROJECT_REGISTER, 'Hosted project registration-on-ingest failed', {
        route: `${method} ${pathname}`,
        error: outcome.error,
      });
    }
  }

  private databaseForRequestContext(context: MycoRequestContext): Database | null {
    if (
      !context.groveId
      && path.resolve(context.databasePath) === path.resolve(vaultDbPath(this.vaultDir))
    ) {
      return null;
    }
    return this.runtimeCache.getDatabase(context.databasePath);
  }

  private closeRequestDatabases(): void {
    if (this.ownsRuntimeCache) this.runtimeCache.closeAll();
  }

  private async handleUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): Promise<void> {
    if (!this.uiDevProxyTarget || !req.url) {
      socket.destroy();
      return;
    }

    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (isDaemonControlPath(pathname)) {
      socket.destroy();
      return;
    }

    const target = new URL(this.uiDevProxyTarget);
    const client = target.protocol === 'https:' ? https : http;
    const proxyReq = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: target.host,
      },
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      const statusLine = `HTTP/${proxyRes.httpVersion} 101 Switching Protocols`;
      const headerLines: string[] = [statusLine];
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) headerLines.push(`${key}: ${item}`);
        } else {
          headerLines.push(`${key}: ${value}`);
        }
      }
      socket.write(`${headerLines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) proxySocket.write(head);
      if (proxyHead.length > 0) socket.write(proxyHead);
      proxySocket.pipe(socket).pipe(proxySocket);
    });

    proxyReq.on('error', (error) => {
      this.logger.warn(LOG_KINDS.SERVER_ERROR, 'UI dev proxy upgrade failed', {
        path: req.url,
        target: this.uiDevProxyTarget,
        error: error.message,
      });
      socket.destroy();
    });

    proxyReq.end();
  }

  updateDaemonJsonSessions(sessions: string[]): void {
    try {
      const info = this.stateAuthority.read();
      if (!info) return;
      info.sessions = sessions;
      this.stateAuthority.write(info, { reason: 'sessions-update' });
    } catch { /* daemon state may not exist during shutdown */ }
  }

  /**
   * Kill any existing daemon competing for this daemon's identity before
   * taking over. Prevents orphaned daemons when spawned from worktrees or
   * plugin upgrades. Must be called BEFORE `server.start()` so the old
   * daemon releases the canonical port.
   *
   * The eviction scope comes from the SERVICE state (where daemon.json
   * actually lives and where the canonical port derives from), not the
   * bootstrap vault — global daemons keep no state under the vault, so a
   * vault-derived sweep finds nothing. The vault is passed along only for
   * the legacy per-vault identity check.
   */
  async evictExistingDaemon(): Promise<void> {
    const service = resolveDaemonServiceState(this.vaultDir, { env: process.env });
    await evictDaemons(
      {
        stateDir: service.stateDir,
        canonicalPort: service.canonicalPort,
        vaultDir: this.vaultDir,
      },
      { logger: this.logger },
    );
  }

  private writeDaemonJson(): void {
    this.stateAuthority.write(this.currentDaemonState(), { reason: 'server-start-listen' });
  }
}

/**
 * Inject the daemon-issued bearer token into the dashboard HTML so the
 * browser-side `fetchJson` wrapper can attach `x-myco-auth` to
 * context-switching API calls. Without this the `/api/stats` endpoint
 * rejects context-aware URLs with `unauthorized_context_switch`.
 *
 * Throws if the source HTML lacks `</head>` — silent no-op would leave
 * the dashboard dead in the water with no signal in logs. We'd rather
 * fail loudly on the first request and surface the regression in CI.
 */
function injectDashboardBootstrap(html: string, authToken: string): string {
  const safeToken = JSON.stringify(authToken);
  const bootstrap = `<script>window.__MYCO_AUTH__=${safeToken};</script>`;
  if (!html.includes('</head>')) {
    throw new Error('dashboard HTML is missing </head>; cannot inject auth bootstrap');
  }
  return html.replace('</head>', `${bootstrap}</head>`);
}

/** True for HTTP methods that may write state (POST/PUT/PATCH/DELETE). */
function isWriteMethod(method: string | undefined): boolean {
  if (!method) return false;
  const upper = method.toUpperCase();
  return upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE';
}

/**
 * True when a write hitting the pause gate is the move POST for the very
 * project a 'grove-move' pause is guarding. A move that crashed mid-op
 * leaves its pause held; the only HTTP path that resumes (or fresh-starts)
 * that move is POST /api/groves/:id/projects/:projectId, and
 * `moveProjectBetweenGroves` arbitrates the pause itself — it re-takes
 * the same owner_op idempotently and surfaces a real owner conflict.
 * Matched on the pause's reason plus the exact route shape for the same
 * project, never a blanket exemption: every other write for the paused
 * project (including the /archive and /unarchive siblings, which carry a
 * trailing segment) stays refused.
 */
function isMoveRetryRequest(
  method: string | undefined,
  pathname: string,
  params: Record<string, string>,
  pauseReason: string,
  projectId: string,
): boolean {
  if (method?.toUpperCase() !== 'POST') return false;
  if (pauseReason !== 'grove-move') return false;
  if (!params.id || params.projectId !== projectId) return false;
  return pathname === `/api/groves/${params.id}/projects/${params.projectId}`;
}

/**
 * Generate a fresh per-daemon-process bearer token. 32 random bytes
 * encoded as hex gives 256 bits of entropy. Exported via env so spawned
 * children inherit it; persisted into daemon.json so manually-invoked
 * children can fetch it without env inheritance.
 */

function mintDaemonAuthToken(): string {
  // Honor an existing env-provided token (set by tests, or by a
  // previous daemon process this child was forked from) so the value
  // round-trips through process restarts when MYCO_DAEMON_AUTH is
  // explicitly carried — but only when it looks like a real token.
  const inherited = process.env[REQUEST_CONTEXT_AUTH_ENV];
  if (inherited && /^[0-9a-f]{32,}$/.test(inherited)) return inherited;
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hard cap on request body size. The daemon binds 127.0.0.1 only and is
 * gated by loopback CSRF, so this is defense-in-depth rather than a
 * security boundary — but unbounded reads from a misbehaving local
 * client (or a swap-thrashed hung browser) could OOM the daemon.
 * 8 MB is well above the largest legitimate API request shape.
 */
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

class RequestBodyTooLarge extends Error {
  constructor() { super('Request body exceeds maximum size'); }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        reject(new RequestBodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total > MAX_REQUEST_BODY_BYTES) return;
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// CSRF / Origin / Content-Type gate
// ---------------------------------------------------------------------------

interface Rejection {
  status: number;
  error: string;
}

/**
 * Reject cross-origin / non-JSON mutating requests before they reach a route
 * handler. Keeps the daemon's stored API keys and write operations out of
 * reach of any webpage the user happens to visit.
 *
 * - Host header must identify the loopback listener (or be absent).
 * - Origin header, when present, must point to the same loopback listener.
 * - Mutating methods with a non-empty body must declare application/json.
 */
export function validateLoopbackRequest(
  req: http.IncomingMessage,
  port: number,
): Rejection | null {
  const host = req.headers.host;
  if (host && !isLoopbackHost(host, port)) {
    return { status: 403, error: 'forbidden_host' };
  }

  const origin = req.headers.origin;
  if (origin && !isLoopbackOrigin(origin, port)) {
    return { status: 403, error: 'forbidden_origin' };
  }

  return validateMutatingContentType(req);
}

/**
 * The team listener's CSRF gate.
 *
 * There is no Host allowlist here, and its absence is deliberate. The overlay
 * listener bound a loopback TCP port that any local process could reach, so
 * `Host: <overlay_ip>:<port>` was the only thing separating a member's request
 * from a local one — a string comparison doing structural work. The team
 * listener binds an `AF_UNIX` socket in a `0700` directory, so reachability is
 * a filesystem permission and there is no port to squat; admission rests on the
 * bearer, and the mount-time `Host` header is whatever the Funnel edge rewrote
 * it to, which is not a value this daemon can predict or verify.
 *
 * `Origin` is still refused outright. Daemon↔daemon traffic never sets it, so
 * its presence means a browser is driving this surface — and with the Host
 * check gone this rule is now the only thing standing between a cross-origin
 * page and the team API.
 */
export function validateTeamRequest(req: http.IncomingMessage): Rejection | null {
  if (req.headers.origin) {
    return { status: 403, error: 'forbidden_origin' };
  }
  return validateMutatingContentType(req);
}

/**
 * The mutating-body content-type check shared by the loopback and overlay CSRF
 * gates. DELETE with an empty body is the common case (e.g. /api/plans/:id) and
 * is allowed without Content-Type. For any non-empty body on a mutating route,
 * require JSON so text/plain CSRF cannot smuggle parsed JSON in.
 */
function validateMutatingContentType(req: http.IncomingMessage): Rejection | null {
  if (!isWriteMethod(req.method)) return null;

  const contentLengthHeader = req.headers['content-length'];
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  const hasBody = Number.isFinite(contentLength) ? contentLength > 0 : (req.headers['transfer-encoding'] ?? '').length > 0;
  if (!hasBody) return null;

  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return { status: 415, error: 'unsupported_media_type' };
  }

  return null;
}

// Node passes the listening host verbatim; some clients omit the port
// entirely on default ports. The daemon never uses port 80, so require
// an explicit port match. Keep the three-form allowlist tight — `[::1]`
// is legitimate now that the IPv6-loopback companion listener serves the
// same port.
function isLoopbackHost(host: string, port: number): boolean {
  const portStr = String(port);
  return (
    host === `127.0.0.1:${portStr}` ||
    host === `localhost:${portStr}` ||
    host === `[::1]:${portStr}`
  );
}

function isLoopbackOrigin(origin: string, port: number): boolean {
  const portStr = String(port);
  return (
    origin === `http://127.0.0.1:${portStr}` ||
    origin === `http://localhost:${portStr}` ||
    origin === `http://[::1]:${portStr}`
  );
}


/**
 * Probe whether a socket file has a live owner. Fail toward LIVE: only
 * ECONNREFUSED/ENOENT prove staleness — any other error (EACCES, a full
 * backlog, a reset) or a hung connect means we must NOT unlink, because
 * unlinking a socket another daemon is serving silently steals its listener.
 * Bounded so a wedged filesystem cannot hang the bind.
 */
async function socketHasLiveOwner(socketPath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.connect(socketPath);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (alive: boolean) => {
      if (timer !== undefined) clearTimeout(timer);
      try { probe.destroy(); } catch { /* already gone */ }
      resolve(alive);
    };
    timer = setTimeout(() => done(true), 2_000);
    probe.once('connect', () => done(true));
    probe.once('error', (err: NodeJS.ErrnoException) => {
      done(!(err.code === 'ECONNREFUSED' || err.code === 'ENOENT'));
    });
  });
}

/**
 * Apply the daemon's protective HTTP server limits.
 *
 * Node's HTTP server defaults are tuned for serving public-internet
 * clients — long keep-alive, generous slow-loris tolerance, no cap on
 * how many requests reuse a single socket. The daemon listens only on
 * loopback, so every legitimate client is on the same machine and we
 * can be much tighter.
 *
 * The motivating incident: 250 concurrent `curl` probes against
 * `/health` filled the kernel's accept queue and the daemon's fd table
 * (launchd capped at 256 NOFILE) faster than the server could drain
 * them. Once the fd table was full, `accept()` returned EMFILE and the
 * SYN queue overflowed — new clients couldn't even complete the TCP
 * handshake. With these limits in place, idle keep-alives are reaped
 * every 5s, slow-header attackers drop after 10s, and one client can't
 * monopolize a socket past `HTTP_MAX_REQUESTS_PER_SOCKET` reuses.
 *
 * Exported so the regression test can verify the limits are applied
 * without standing up a full `DaemonServer`.
 */
export function applyDaemonHttpServerLimits(server: http.Server): void {
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.maxRequestsPerSocket = HTTP_MAX_REQUESTS_PER_SOCKET;
}

/** TCP listen backlog used by the daemon. Exported so service installers
 *  / consumers that bind their own listener can match it. */
export const DAEMON_HTTP_LISTEN_BACKLOG = HTTP_LISTEN_BACKLOG;

function isDaemonControlPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname === '/health' || pathname === '/ready';
}

/**
 * Force a Node HTTP server through a fast, deterministic shutdown.
 *
 * `http.Server.close()` only stops accepting *new* connections — it
 * waits for every existing connection to disconnect on its own before
 * invoking its callback. UI keep-alives, MCP HTTP clients, and
 * WebSocket upgrades happily hold sockets open for ~90s after we asked
 * them to leave, which makes every daemon restart look broken (old
 * daemon still holding the port, new daemon unable to bind).
 *
 *   1. `closeIdleConnections()` drops sockets that aren't mid-request
 *      immediately (Node 18.2+).
 *   2. A short grace window lets an in-flight request finish its
 *      response cycle.
 *   3. `closeAllConnections()` yanks anything still holding a socket —
 *      WebSocket upgrades, long-poll clients, anything that wouldn't
 *      otherwise notice we said goodbye.
 *
 * After that, the `close()` callback fires immediately because the
 * sockets are gone. Exported so the regression test can exercise the
 * timing property without standing up a full `DaemonServer`.
 */
export function gracefullyCloseHttpServer(
  server: http.Server,
  options: { gracePeriodMs: number },
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.closeIdleConnections();
    // `server.close(cb)` invokes its callback only after every existing
    // socket has finished. With bun's HTTP runtime that callback is not
    // reliably fired even after `closeAllConnections()` has destroyed
    // the sockets, so we don't depend on it: we drive completion from
    // the operations we control. The callback path is still wired so
    // we resolve on the fast path (no force-close needed) when the
    // runtime does fire it.
    server.close(finish);
    const forceClose = setTimeout(() => {
      server.closeAllConnections();
      // closeAllConnections returns synchronously after destroying
      // every socket — the server has now stopped accepting new
      // connections (close() was called above) and severed every
      // existing one. Anything still waiting on the close() callback
      // is the runtime, not real work; resolve and move on.
      finish();
    }, options.gracePeriodMs);
    forceClose.unref?.();
  });
}
