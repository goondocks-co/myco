import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonLogger } from './logger.js';
import { getPluginVersion } from '../version.js';
import { Router, type RouteHandler } from './router.js';
import { resolveStaticFile, resolveEmbeddedAsset } from './static.js';
import { evictDaemons } from './eviction.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import {
  ForeignGroveError,
  REQUEST_CONTEXT_AUTH_ENV,
  UnauthorizedRequestContextError,
  UnknownRequestContextError,
  requestContextFromHttpHeaders,
  requestContextFromTenancyIds,
  resolveInboundProjectId,
  type MycoRequestContext,
} from '../grove/request-context.js';
import { isGroveEraId, type GroveProjectId } from '../grove/ids.js';
import { classifyRoute, refusalJson, type RefusalPayload } from '../host/routing.js';
import { handleAttachedRequest } from './host-proxy.js';
import { isProjectPaused, UnknownGroveError } from '../grove/registry.js';
import { pausedErrorResponse } from './api/error-envelope.js';
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
  /**
   * Capability for mutating `daemon.json`. The ONLY way the server
   * writes state. Required for production callers; tests that don't
   * exercise the listen callback may omit it, in which case the server
   * constructs one from `resolveDaemonServiceState(vaultDir)`.
   */
  daemonStateAuthority?: DaemonStateAuthority;
  uiDir?: string;
  uiDevProxyTarget?: string;
  onRequest?: () => void;
  /**
   * Shared bounded LRU for per-Grove DB handles + embedding runtime.
   * If omitted, the server creates a private cache; pass an externally
   * owned one when other subsystems need to share entries.
   */
  runtimeCache?: GroveRuntimeCache;
}

export type RawRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

export class DaemonServer {
  port = 0;
  readonly version: string;
  uiDir: string | null;
  uiDevProxyTarget: string | null;
  private server: http.Server | null = null;
  private vaultDir: string;
  private stateAuthority: DaemonStateAuthority;
  private logger: DaemonLogger;
  private router = new Router();
  private rawRoutes = new Map<string, RawRouteHandler>();
  private onRequest: (() => void) | null;
  /**
   * Cooperative-shutdown trigger. Wired late (after the graceful-shutdown
   * closure is built in main.ts) via {@link onShutdownRequest}; a POST to
   * `/api/shutdown` invokes it. This is how a successor daemon or the updater
   * drains THIS daemon on Windows, where a cross-process SIGTERM maps to an
   * uncatchable `TerminateProcess` and the signal-based shutdown never runs.
   */
  private shutdownRequestHandler: (() => void) | null = null;
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

  constructor(config: DaemonServerConfig) {
    this.vaultDir = config.vaultDir;
    this.logger = config.logger;
    this.stateAuthority = config.daemonStateAuthority
      ?? createDaemonStateAuthority(
        resolveDaemonServiceState(config.vaultDir, { env: process.env }),
        config.logger,
      );
    this.uiDir = config.uiDir ?? null;
    this.uiDevProxyTarget = config.uiDevProxyTarget ?? null;
    this.onRequest = config.onRequest ?? null;
    this.runtimeCache = config.runtimeCache ?? new GroveRuntimeCache();
    this.ownsRuntimeCache = config.runtimeCache === undefined;
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
  currentDaemonState(): DaemonState {
    return {
      pid: process.pid,
      port: this.port,
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
  onShutdownRequest(handler: () => void): void {
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
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // No daemon.json unlink — see reconcileExistingDaemon for cleanup ownership.
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
      // Respond BEFORE tearing down so the caller observes the 202, then start
      // the graceful drain only once the body has flushed to the socket.
      res.writeHead(202, { 'Content-Type': 'application/json', ...versionHeader });
      res.end(JSON.stringify({ myco: true, shutting_down: true }), () => {
        handler();
      });
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
      const rejection = validateLoopbackRequest(req, this.port);
      if (rejection) {
        res.writeHead(rejection.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: rejection.error }));
        return;
      }
      this.onRequest?.();
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
      const rejection = validateLoopbackRequest(req, this.port);
      if (rejection) {
        res.writeHead(rejection.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: rejection.error }));
        return;
      }

      this.onRequest?.();
      const versionHeader = { 'X-Myco-Api-Version': this.version };
      try {
        // Team Host chokepoint: an attached project is served by a remote host
        // daemon. Resolve tenancy cheaply and route BEFORE the body is read and
        // BEFORE any local Grove/DB resolution — the proxy pipes the raw request
        // stream, and an attached project must never open a local Grove DB. A
        // non-attached project (the common case) returns `local` after a single
        // empty-set registry probe, so the path below is byte-identical.
        const inboundProjectId = this.inboundProjectId(match.params, req.headers);
        const decision = classifyRoute({
          method: req.method!,
          pathname: match.pathname,
          projectId: inboundProjectId,
        });
        if (decision.kind === 'degraded' || decision.kind === 'config_locked') {
          this.writeRefusal(res, decision.refusal, versionHeader);
          return;
        }
        if (decision.kind === 'remote') {
          await handleAttachedRequest(req, res, decision.target, decision.classification);
          return;
        }

        const needsBody = isWriteMethod(req.method);
        const body = needsBody ? await readBody(req) : undefined;
        const requestContext = this.resolveRouteRequestContext(match.params, req.headers);
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
        const invokeHandler = () => match.handler({
          body,
          query: match.query,
          params: match.params,
          pathname: match.pathname,
          headers: req.headers,
          requestContext,
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
    });
  }

  /**
   * Effective project id for the Team Host routing chokepoint, resolved without
   * any Grove/DB lookup. URL-tenancy routes (`/api/g/:groveId/p/:projectId/...`)
   * carry the id in the path; everything else goes through the header/manifest
   * pre-parse (which also runs the local bearer gate exactly as the full
   * resolver does). A malformed id resolves to null so the request falls through
   * to today's local resolver, which reports the error exactly as before.
   */
  private inboundProjectId(
    params: Record<string, string>,
    headers: http.IncomingMessage['headers'],
  ): GroveProjectId | null {
    if (params.groveId && params.projectId) {
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

  if (!isWriteMethod(req.method)) return null;

  // DELETE with an empty body is the common case (e.g. /api/plans/:id) and
  // is allowed without Content-Type. For any non-empty body on a mutating
  // route, require JSON so text/plain CSRF cannot smuggle parsed JSON in.
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
