import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonLogger } from './logger.js';
import { createTailscaleCli, type TailscaleCli } from '../host/tailscale-cli.js';
import { realCommandRunner } from '../host/overlay-binaries.js';
import { resolveHostTailscaledSocketPath } from '../grove/paths.js';
import { readHostState } from '../team-host/state.js';
import { reconcileOverlayForward, retireOverlayForward, retireUnheldOverlayForwards } from './overlay-forward.js';
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
  isBindableOverlayAddress,
  isOverlayRequest,
  markOverlayRequest,
  overlayBearerExempt,
  overlayBearerRejection,
  overlayLifecycleRefused,
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
  /** Override the host tailscale CLI used for overlay-forward management
   *  (tests). Production resolves it from recorded host state. */
  hostTailscaleCliFactory?: () => TailscaleCli | null;
  /** Override the host tailscaled control-socket path used by the
   *  overlay-forward wire (tests). Production resolves it from grove paths. */
  hostTailscaledSocketPath?: string;
  /** Override the socket wait before wiring the overlay forward (tests), so a
   *  guard regression fails on an ASSERTION rather than a harness timeout. */
  hostTailscaledSocketTimeoutMs?: number;
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
   * SECOND listener on `overlayAddress` where every request passes the
   * transport-boundary gate (blanket bearer + version + shutdown refusal). When
   * `null`/omitted, host serving is off and only the loopback listener binds.
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

/**
 * The overlay listener's bind address. ALWAYS loopback: `overlay_address` is
 * an advertised identity, not a local interface — userspace-networking mode
 * creates no TUN, so the 100.64 address is not bindable on this host at all.
 * Reachability comes from tailscaled's `serve --tcp` forward, which is the
 * only network path to this listener. Hardcoded so no config value can widen
 * the bind (server-mode design spec §9, as restated by the coexistence
 * amendment: never a wildcard, never a non-loopback address).
 */
const OVERLAY_BIND_ADDRESS = '127.0.0.1';

/** How long to wait for the host tailscaled control socket before wiring the
 *  overlay forward. On a reboot the daemon usually wins the race against its
 *  own user-domain agent, so this is the common path, not the rare one. */
const OVERLAY_FORWARD_SOCKET_TIMEOUT_MS = 10_000;

export class DaemonServer {
  port = 0;
  readonly version: string;
  uiDir: string | null;
  uiDevProxyTarget: string | null;
  private server: http.Server | null = null;
  /**
   * The Team Host overlay listener — a SECOND HTTP server bound to the host's
   * overlay interface address (never 0.0.0.0). Null unless host serving is
   * enabled AND the overlay bind succeeds. Every request here passes the
   * transport-boundary gate ({@link handleOverlayRequest}) before dispatch.
   */
  private overlayServer: http.Server | null = null;
  private hostServe: HostServeRuntime | null;
  /** Seam for the host tailscale CLI used to manage the overlay forward.
   *  Production resolves it from recorded host state; tests inject a fake so
   *  the real bind/stop ordering is exercised rather than modelled. */
  private readonly hostTailscaleCliFactory: (() => TailscaleCli | null) | null;
  private readonly hostTailscaledSocketPathOverride: string | null;
  private readonly hostTailscaledSocketTimeoutMs: number;
  /** Capture-side proxy deps (transcript-drain flush + collect enqueue) threaded
   *  into `handleAttachedRequest` for attached projects. See {@link DaemonServerConfig}. */
  private hostProxyDeps: Partial<HostProxyDeps>;
  private lockNamespace: PerUserLockNamespace;
  /** The overlay listener's bound port (0 until it binds). Public so tests /
   *  enrollment can read the port the overlay surface is reachable on. */
  overlayPort = 0;
  /** The overlay listener's actually-bound address (null until it binds).
   *  Public so enrollment records the real address and tests can assert the
   *  bind is the overlay IP and never a wildcard/0.0.0.0. */
  overlayBoundAddress: string | null = null;
  /** In-flight overlay-forward wiring, awaited by {@link stop} so a shutdown
   *  can never race a wire into existence AFTER the retire. */
  private overlayForwardWire: Promise<void> | null = null;
  /** Bumped whenever the overlay listener goes down. A wire that started under
   *  an older generation refuses to touch tailscaled — the daemon no longer
   *  holds the port, so it has no right to point a forward at it. */
  private overlayForwardGeneration = 0;
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
    this.hostTailscaleCliFactory = config.hostTailscaleCliFactory ?? null;
    this.hostTailscaledSocketPathOverride = config.hostTailscaledSocketPath ?? null;
    this.hostTailscaledSocketTimeoutMs = config.hostTailscaledSocketTimeoutMs ?? OVERLAY_FORWARD_SOCKET_TIMEOUT_MS;
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
    return this.overlayServer !== null;
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
        // Bring up the Team Host overlay listener (if host serving is enabled).
        // It never rejects — a bind failure leaves host serving off and the
        // loopback daemon fully up. Awaited so `start()` resolves with the
        // overlay port set (and, in tests, before the overlay surface is hit).
        this.startOverlayListener().then(() => resolve());
      });
    });
  }

  /**
   * Bind the Team Host overlay listener — a SECOND HTTP server on the host's
   * overlay interface address ONLY (never 0.0.0.0, never a LAN IP). Every request
   * on it passes {@link handleOverlayRequest}'s transport-boundary gate before
   * dispatch. No-op (and never throws) when host serving is off; a bind failure
   * (overlay IP not up / TUN not attached) logs once and leaves host serving off
   * — never a crash, never a wider fallback bind (Task 2.3 item 1).
   */
  private startOverlayListener(): Promise<void> {
    return new Promise((resolve) => {
      // Re-entry guard. A second call while already bound would hit EADDRINUSE
      // on a port THIS process holds, and the squatted branch would then retire
      // our own forward and null `overlayServer` — orphaning the still-listening
      // first server so `stop()` can never close it.
      if (this.overlayServer) { resolve(); return; }

      const hostServe = this.hostServe;
      // NOT SERVING IS A CONVERGENCE TARGET, not merely an absence of action.
      // The rule is bidirectional: a forward may exist only while this process
      // holds the port, so every path that ends with us NOT holding it must
      // retire whatever is there. Wiring-only enforced half the rule and left a
      // durable forward delivering member bearers to whatever binds the port.
      if (!hostServe) { void this.retireAllOverlayForwards().finally(() => resolve()); return; }

      const address = hostServe.overlayAddress;
      if (!isBindableOverlayAddress(address)) {
        this.logger.warn(LOG_KINDS.HOST_SERVE, 'Refusing to bind Team Host overlay listener on a non-advertisable address — host serving stays off', {
          overlay_address: address,
        });
        void this.retireAllOverlayForwards().finally(() => resolve());
        return;
      }

      // Members dial `<overlay_ip>:<overlay_port>`; a `tailscale serve --tcp`
      // forward carries that to THIS loopback listener. The bind address is
      // hardcoded loopback — since the coexistence move to userspace
      // networking there is no TUN interface to bind, and `overlay_address` is
      // an ADVERTISED identity rather than a local address. There is no
      // `?? this.port` fallback: without a persisted port the runtime never
      // resolves (`resolveHostServeConfig`), because falling back to the
      // canonical port collides with the loopback listener below.
      const overlayPort = hostServe.overlayPort;

      const overlay = http.createServer((req, res) => {
        this.handleOverlayRequest(req, res).catch((err) => {
          this.logUnhandledTransportFailure('request', err);
          try {
            if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal_error' }));
          } catch { /* socket already gone */ }
        });
      });
      // The overlay carries only daemon↔daemon API traffic — no WebSocket, no
      // Vite dev proxy. Destroy any upgrade attempt outright.
      overlay.on('upgrade', (_req, socket) => { try { socket.destroy(); } catch { /* already gone */ } });
      applyDaemonHttpServerLimits(overlay);

      const onBindError = (err: NodeJS.ErrnoException) => {
        // EADDRINUSE is the SIGKILL residual: a durable forward may still be
        // sending member traffic — bearer tokens included — to whatever now
        // holds this port. Retire the forward and stay off, loudly. Anything
        // less turns "leaks until the next start" into "leaks forever".
        const squatted = err.code === 'EADDRINUSE';
        this.logger.warn(
          LOG_KINDS.HOST_SERVE,
          squatted
            ? 'Team Host overlay port is held by another process — host serving stays OFF and the overlay forward is being retired so member traffic is not delivered to it'
            : 'Team Host overlay listener failed to bind — host serving stays off',
          {
            bind_address: OVERLAY_BIND_ADDRESS,
            overlay_address: address,
            port: overlayPort,
            error: err.message,
            code: err.code ?? null,
          },
        );
        try { overlay.close(); } catch { /* not listening */ }
        // The listener is not up, so no in-flight wire may touch tailscaled.
        this.overlayForwardGeneration += 1;
        // Only clear the registration if it is still OURS: two overlapping
        // starts can both pass the re-entry guard, and the loser must not
        // clobber the winner's registration — the exact orphan the guard exists
        // to prevent.
        if (this.overlayServer === overlay) this.overlayServer = null;
        // EVERY bind failure ends with us not holding the port, so every one
        // retires. EADDRINUSE is only the loudest case: an EMFILE under fd
        // pressure leaves the port held by NOBODY while the forward stays live.
        if (!squatted) { void this.retireAllOverlayForwards().finally(() => resolve()); return; }
        // Await the retire before resolving: on this path another process is
        // already holding the port, so a forward left in place is actively
        // delivering member bearer tokens to it. `.finally` — NOT `.then` —
        // because this sits on the daemon's boot path, and "never rejects" is
        // not the same as "always settles": resolving only on success would
        // wedge boot if the retire ever failed to settle.
        void this.retireOverlayForward(overlayPort).finally(() => resolve());
      };
      overlay.once('error', onBindError);

      overlay.listen(overlayPort, OVERLAY_BIND_ADDRESS, HTTP_LISTEN_BACKLOG, () => {
        overlay.removeListener('error', onBindError);
        // Keep a persistent error handler so a post-bind socket error is logged
        // rather than thrown as an unhandled 'error' event (which exits the process).
        overlay.on('error', (err) => {
          this.logger.warn(LOG_KINDS.HOST_SERVE, 'Team Host overlay listener socket error', { error: (err as Error).message });
        });
        const addr = overlay.address() as { address: string; port: number } | null;
        this.overlayServer = overlay;
        this.overlayPort = addr?.port ?? overlayPort;
        this.overlayBoundAddress = addr?.address ?? address;
        // Report BOTH: the bind is loopback, but an operator reading only that
        // would read a healthy host as broken. The advertised pair is what
        // members actually dial.
        this.logger.info(LOG_KINDS.HOST_SERVE, 'Team Host overlay listener bound', {
          bind_address: this.overlayBoundAddress,
          port: this.overlayPort,
          advertised: `${address}:${this.overlayPort}`,
        });
        // The bind IS the ownership proof, so the forward is wired only now —
        // never while the port is unowned. Reconciles rather than adds, so a
        // superseded port's durable forward cannot outlive it.
        this.overlayForwardWire = this.wireOverlayForward(this.overlayPort, this.overlayForwardGeneration)
          .catch(() => {}); // stored, not awaited here — an unhandled rejection exits under Bun
        resolve();
      });
    });
  }

  /**
   * Resolve a {@link TailscaleCli} bound to THIS machine's host tailscaled, or
   * null when the host has no recorded overlay state (never enabled, or torn
   * down). Null is not an error — it just means there is no forward to manage.
   */
  private resolveHostTailscaleCli(): TailscaleCli | null {
    if (this.hostTailscaleCliFactory) return this.hostTailscaleCliFactory();
    const state = readHostState();
    if (!state?.tailscale_bin) return null;
    return createTailscaleCli({
      runner: realCommandRunner,
      tailscaleBin: state.tailscale_bin,
      socketPath: this.hostTailscaledSocketPathOverride ?? resolveHostTailscaledSocketPath(),
    });
  }

  /**
   * Converge the overlay forward on `port` after a successful bind.
   *
   * Waits for tailscaled's control socket first: on a reboot the daemon
   * commonly starts BEFORE its user-domain tailscaled agent, so an immediate
   * `tailscale serve` would fail on the likely ordering rather than the
   * unlucky one. A failure here is loud, never best-effort — silently
   * proceeding yields a bound listener with no forward, which is a durable
   * outage that `/api/host-serve/status` would still report as healthy.
   */
  private async wireOverlayForward(port: number, generation: number): Promise<void> {
    const cli = this.resolveHostTailscaleCliSafe();
    if (!cli) return;
    try {
      const socketPath = this.hostTailscaledSocketPathOverride ?? resolveHostTailscaledSocketPath();
      const deadline = Date.now() + this.hostTailscaledSocketTimeoutMs;
      while (!fs.existsSync(socketPath) && Date.now() < deadline) {
        if (generation !== this.overlayForwardGeneration) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      // The listener may have gone down while we waited for the socket. Wiring
      // now would leave a live forward aimed at a port this process no longer
      // holds — the exact leak the bind-is-the-proof rule exists to prevent.
      if (generation !== this.overlayForwardGeneration) return;
      await reconcileOverlayForward(cli, port, this.logger);
    } catch (err) {
      this.logger.warn(
        LOG_KINDS.HOST_SERVE,
        'Overlay forward could not be wired — the listener is bound but UNREACHABLE from the tailnet. '
        + 'Check the host tailscaled service, then re-run `myco host enable`.',
        { port, error: (err as Error).message },
      );
    }
  }

  /**
   * Converge this machine's tailscaled on the invariant: no forward may point
   * at a port nothing holds. Used on every path that ends with this process
   * not holding an overlay port, where the specific port may be unknown.
   *
   * It retires only UNHELD ports. Host state is machine-global (`~/.myco-team`,
   * independent of `MYCO_HOME`), so several daemons share one tailscaled —
   * retiring every forward we could see would tear down a SIBLING's live one,
   * which on a box running dogfood beside prod would happen on every boot.
   * Never throws.
   */
  private async retireAllOverlayForwards(): Promise<void> {
    const cli = this.resolveHostTailscaleCliSafe();
    if (!cli) return;
    await retireUnheldOverlayForwards(cli, this.logger);
  }

  /** {@link resolveHostTailscaleCli}, but never throws — `createTailscaleCli`
   *  rejects an empty socket path by design, and these callers are on the
   *  boot/shutdown paths where a throw would skip the work that follows. */
  private resolveHostTailscaleCliSafe(): TailscaleCli | null {
    try { return this.resolveHostTailscaleCli(); } catch { return null; }
  }

  /** Remove the overlay forward for `port`. Never throws — teardown must not
   *  be blocked by a tailscaled that is already gone. */
  private async retireOverlayForward(port: number): Promise<void> {
    const cli = this.resolveHostTailscaleCliSafe();
    if (!cli) return;
    try {
      await retireOverlayForward(cli, port);
      this.logger.info(LOG_KINDS.HOST_SERVE, 'Overlay forward retired', { port });
    } catch (err) {
      this.logger.warn(
        LOG_KINDS.HOST_SERVE,
        'Overlay forward could not be retired — it may still route member traffic to this port',
        { port, error: (err as Error).message },
      );
    }
  }

  /**
   * Retire this machine's overlay forwards, WITHOUT the rest of shutdown. The
   * listener itself is closed later by `stop()`; removing the forward is what
   * actually severs member reachability, since it is the only network path in. Called at the very top of the shutdown
   * sequence because everything after it can block past the supervisor's kill
   * timeout, and a forward that outlives the process keeps routing member
   * traffic to a port nothing holds. Idempotent and never throws — `stop()`
   * still retires as a backstop.
   */
  async retireOverlayExposure(): Promise<void> {
    this.overlayForwardGeneration += 1;
    const inFlightWire = this.overlayForwardWire;
    this.overlayForwardWire = null;
    if (inFlightWire) await inFlightWire.catch(() => {});

    // OUR port is retired explicitly, not through the unheld filter: we are
    // shutting down but still holding it, so a liveness probe would (rightly)
    // report it held and skip it. Knowing the port is exactly what entitles us
    // to remove its forward.
    if (this.overlayPort > 0) await this.retireOverlayForward(this.overlayPort);
    // Then converge anything else pointing at a port nobody holds.
    await this.retireAllOverlayForwards();
  }

  async stop(): Promise<void> {
    // No daemon.json unlink — see reconcileExistingDaemon for cleanup ownership.
    const overlay = this.overlayServer;
    const retiringPort = this.overlayPort;
    // Claim the fields BEFORE any await, so a concurrent stop() sees them
    // already taken and does not close or retire a second time.
    this.overlayServer = null;
    // Invalidate any in-flight wire FIRST, then await it, so the retire below
    // cannot be undone by a wire that was already waiting on the socket.
    this.overlayForwardGeneration += 1;
    const inFlightWire = this.overlayForwardWire;
    this.overlayForwardWire = null;
    if (inFlightWire) await inFlightWire.catch(() => {});
    this.overlayBoundAddress = null;
    this.overlayPort = 0;
    if (overlay) {
      // Retire the forward BEFORE releasing the port, so there is no instant
      // where a live forward points at a port this process no longer holds.
      if (retiringPort > 0) await this.retireOverlayForward(retiringPort);
      await gracefullyCloseHttpServer(overlay, { gracePeriodMs: SERVER_STOP_FORCE_CLOSE_GRACE_MS });
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
   * The Team Host transport-boundary gate — runs on the overlay listener ONLY,
   * BEFORE raw-route dispatch and BEFORE the router (spec §9). Order:
   *   1. overlay CSRF (Host is the overlay address; Origin is refused — no
   *      browsers on the overlay) + the shared mutating-body content-type check;
   *   2. blanket bearer — EVERY overlay request (router, raw, `/mcp`) or 401;
   *   3. lifecycle refusal — `/api/shutdown` (operator control plane) is 404 over
   *      the overlay regardless of a valid bearer. Checked AFTER the bearer so a
   *      no-bearer request still gets 401 on every route, and the shutdown handler
   *      is never invoked either way;
   *   4. version window — else 409 `protocol_version_unsupported` (both bounds).
   * On pass, the local daemon bearer is stamped and the request is marked overlay,
   * then it flows into the SAME dispatch as a localhost request.
   */
  private async handleOverlayRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const versionHeader = { 'X-Myco-Api-Version': this.version };
    const hostServe = this.hostServe;
    if (!hostServe) {
      // Unreachable in practice (the overlay listener only runs when hostServe is
      // set), but fail closed rather than serve unauthenticated.
      this.writeOverlayRefusal(res, 503, { error: 'host_serve_unavailable' }, versionHeader);
      return;
    }
    const pathname = new URL(req.url!, 'http://localhost').pathname;

    // (1) Overlay CSRF: narrow Host allowlist + no-Origin, then shared content-type.
    const csrf = validateOverlayRequest(req, hostServe.overlayAddress, this.overlayPort);
    if (csrf) {
      this.writeOverlayRefusal(res, csrf.status, { error: csrf.error }, versionHeader);
      return;
    }

    // (2) Blanket bearer — EXCEPT the ONE enrollment route (spec §8/§9). A member
    // obtains the bearer THERE, so gating enrollment behind the bearer is a
    // chicken-and-egg deadlock; overlay membership is its trust boundary instead.
    // The exemption is surgical (overlayBearerExempt matches only that exact path)
    // and the route's own handler re-asserts overlay provenance, so a no-bearer
    // request to ANY OTHER overlay route still 401s here.
    if (!overlayBearerExempt(pathname)) {
      const bearerRejection = overlayBearerRejection(req, hostServe.bearer);
      if (bearerRejection) {
        this.writeOverlayRefusal(res, bearerRejection.status, bearerRejection.body, versionHeader, bearerRejection.headers);
        return;
      }
    }

    // (3) Lifecycle/operator raw routes are never overlay-served.
    if (overlayLifecycleRefused(pathname)) {
      this.writeOverlayRefusal(res, 404, { error: 'not_found', message: 'This route is served on localhost only, not over the overlay.' }, versionHeader);
      return;
    }

    // (4) Version window.
    const versionRejection = overlayVersionRejection(req);
    if (versionRejection) {
      this.writeOverlayRefusal(res, versionRejection.status, versionRejection.body, versionHeader, versionRejection.headers);
      return;
    }

    // Gate passed. The host bearer proved admission (flat trust, spec §9). Stamp
    // the LOCAL daemon bearer — the member's proxy stripped `x-myco-auth`, and the
    // host's downstream tenancy resolver requires it on context-switching headers —
    // so the host-resident Grove resolves exactly as a local context-switch would.
    // Tenancy headers (project/grove/machine) remain claims, per v1's flat trust.
    req.headers[REQUEST_CONTEXT_AUTH_HEADER] = this.authToken;
    markOverlayRequest(req);
    await this.handleRequest(req, res);
  }

  private writeOverlayRefusal(
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
   * {@link handleOverlayRequest} (bearer, version, lifecycle refusal, and the
   * overlay Host/Origin gate) before delegating here, so they skip the loopback
   * gate; loopback requests get {@link validateLoopbackRequest} unchanged.
   */
  private csrfRejection(req: http.IncomingMessage): Rejection | null {
    return isOverlayRequest(req) ? null : validateLoopbackRequest(req, this.port);
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
      res.end(JSON.stringify({
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

    // Team Host enrollment (Task 2.4) — the ONE overlay route exempt from the
    // blanket bearer gate (a member obtains the bearer HERE; see the surgical
    // exemption in handleOverlayRequest + HOST_ENROLL_ROUTE). A raw route because
    // enrollment needs no Grove/DB/tenancy — it returns machine-scoped host facts.
    this.registerRawRoute(HOST_ENROLL_ROUTE, async (req, res) => {
      // OVERLAY-ONLY is the enrollment gate: because the bearer check is
      // skipped, this route MUST refuse any caller that did not arrive on the
      // overlay listener.
      //
      // READ THE BOUNDARY LITERALLY. This comment used to say "a localhost/LAN
      // hit is never marked overlay", and that is NO LONGER TRUE: since the
      // coexistence move to userspace networking the overlay listener binds
      // 127.0.0.1, so a local process that dials it IS marked overlay and DOES
      // reach this route — which hands back the serve-bearer. The honest
      // boundary is "arrived on the overlay listener, which is loopback; a
      // local process is inside it."
      //
      // Scoped honestly: pre-C1 a local process could dial the TUN address for
      // the same payload, so this is a widened window, not a new class, and it
      // is local-process-only — `validateOverlayRequest` 403s anything
      // carrying `Origin` and `isOverlayHost` demands `overlay_ip:P`, so there
      // is no browser path. What bounds it is port ownership: the daemon wires
      // the inbound forward only while it holds the port (`overlay-forward.ts`).
      // Do not reason from locality here; reason from that.
      if (!isOverlayRequest(req)) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'not_found', message: 'Host enrollment is served over the overlay only.' }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      const hostServe = this.hostServe;
      if (!hostServe) {
        // Unreachable when serving (the overlay listener only runs with hostServe
        // set), but fail closed rather than 500.
        res.writeHead(503, { 'Content-Type': 'application/json', ...versionHeader });
        res.end(JSON.stringify({ error: 'host_serve_unavailable' }));
        return;
      }
      // Best-effort: the member POSTs `{member_hostname, member_overlay_ip}` for the
      // action log. A parse failure never blocks enrollment (the bearer is the
      // point, not the log line).
      let memberInfo: Record<string, unknown> = {};
      try { memberInfo = (await readBody(req)) as Record<string, unknown>; } catch { /* log without it */ }

      const payload = buildHostEnrollmentPayload(hostServe, this.overlayPort);
      const enrollmentNonce = memberInfo.enrollment_nonce;
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
      // (Overlay requests were already gated by handleOverlayRequest — see
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
        if (isOverlayRequest(req)) {
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
        if (!isOverlayRequest(req)) {
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
            await handleAttachedConfigRequest(req, res, match.pathname, decision.target, carveBody, {
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
          hostServed: isOverlayRequest(req),
        };
        // Team Host served-grove filter (Task 2), chokepoint 1 of 2 (see
        // `mcp/http.ts` for chokepoint 2). The bearer/lifecycle/version gate
        // above proves overlay ADMISSION only — it says nothing about WHICH
        // Grove a member may reach. Without this, a bearer-holding member
        // could send `x-myco-grove-id` naming ANY Grove this host owns,
        // including the operator's own personal Groves. Runs immediately
        // after the Grove context resolves, before any handler/DB touch.
        if (isOverlayRequest(req)) {
          const groveRefusal = this.hostServe
            ? servedGroveRefusal(this.hostServe, requestContext.groveId)
            // Unreachable in practice (the overlay listener — and hence
            // isOverlayRequest — only marks requests when hostServe is set),
            // but fail closed exactly like handleOverlayRequest's own
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
            this.writeOverlayRefusal(res, groveRefusal.status, groveRefusal.body, versionHeader, groveRefusal.headers);
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
          isOverlay: isOverlayRequest(req),
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
          if (isOverlayRequest(req)) {
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
    if (isOverlayRequest(req)) {
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
 * The overlay listener's CSRF-equivalent gate (Team Host, spec §9). Narrower
 * than loopback: it accepts ONLY the overlay address as the request Host (for
 * daemon-API calls), and it rejects ANY request carrying an Origin header —
 * daemon↔daemon proxy traffic never sets Origin, so a present Origin means a
 * browser, which is not a supported overlay client (members use their local UI).
 * The mutating-body content-type rule is shared with loopback so a request the
 * member proxied is dispatched byte-identically to how the host would receive it
 * locally. The blanket bearer + version + lifecycle-refusal checks run separately
 * (handleOverlayRequest) — this is only the Host/Origin/content-type layer.
 */
export function validateOverlayRequest(
  req: http.IncomingMessage,
  overlayAddress: string,
  overlayPort: number,
): Rejection | null {
  // REQUIRE the header, don't merely validate it when present. The overlay
  // listener binds plain loopback now, so `overlay_ip:P` in the Host header is
  // the only thing distinguishing a member's request from a local process
  // dialling the same port — and a request that simply omits Host would have
  // skipped the check entirely. A real member always sends it (the CONNECT
  // proxy preserves it; measured on the rig).
  const host = req.headers.host;
  if (!host || !isOverlayHost(host, overlayAddress, overlayPort)) {
    return { status: 403, error: 'forbidden_host' };
  }
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
// an explicit port match. Keep the two-form allowlist tight.
function isLoopbackHost(host: string, port: number): boolean {
  const portStr = String(port);
  return (
    host === `127.0.0.1:${portStr}` ||
    host === `localhost:${portStr}`
  );
}

function isLoopbackOrigin(origin: string, port: number): boolean {
  const portStr = String(port);
  return (
    origin === `http://127.0.0.1:${portStr}` ||
    origin === `http://localhost:${portStr}`
  );
}

// The overlay listener binds exactly the overlay IP on the daemon's port, so the
// only legitimate Host is that address (with or without the explicit port — the
// member's proxy sends `<overlay_ip>:<port>`). A bare-IP Host is also accepted.
function isOverlayHost(host: string, overlayAddress: string, port: number): boolean {
  return host === `${overlayAddress}:${String(port)}` || host === overlayAddress;
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
