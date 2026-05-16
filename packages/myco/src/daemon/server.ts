import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonLogger } from './logger.js';
import { getPluginVersion } from '../version.js';
import { Router, type RouteHandler } from './router.js';
import { resolveStaticFile } from './static.js';
import { evictDaemonsForVault } from './eviction.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import {
  REQUEST_CONTEXT_AUTH_ENV,
  UnauthorizedRequestContextError,
  requestContextFromHttpHeaders,
  type MycoRequestContext,
} from '../tools/request-context.js';
import { isProjectPaused } from '../grove/registry.js';
import { pausedErrorResponse } from './api/error-envelope.js';
import { readDaemonState, writeDaemonState } from './service-state.js';
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
  daemonStatePath?: string;
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
  private daemonStatePath: string;
  private logger: DaemonLogger;
  private router = new Router();
  private rawRoutes = new Map<string, RawRouteHandler>();
  private onRequest: (() => void) | null;
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
   * Cache of post-injection dashboard HTML, keyed by source file path.
   * The token is fixed for the daemon's lifetime and the built HTML is
   * immutable, so reading + injecting on every request is wasted work.
   */
  private htmlCache = new Map<string, string>();

  constructor(config: DaemonServerConfig) {
    this.vaultDir = config.vaultDir;
    this.daemonStatePath = config.daemonStatePath ?? path.join(config.vaultDir, 'daemon.json');
    this.logger = config.logger;
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

  registerRoute(method: string, routePath: string, handler: RouteHandler): void {
    this.router.add(method, routePath, handler);
  }

  registerRawRoute(routePath: string, handler: RawRouteHandler): void {
    this.rawRoutes.set(routePath, handler);
  }

  async start(port: number = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on('upgrade', (req, socket, head) => {
        void this.handleUpgrade(req, socket, head);
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
        this.writeDaemonJson();
        this.logger.info(LOG_KINDS.DAEMON_PORT, 'Server started', { port: this.port, dashboard: `http://localhost:${this.port}/` });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Cleanup ownership inversion: we do NOT call removeDaemonJson() here.
    // If we unlinked first and gracefullyCloseHttpServer then hung (wedged
    // background loop, deadlocked shutdown handler, etc.), we would leave a
    // live process with no discoverable state file — the orphan-zombie
    // failure mode the self-mutation-discipline tenet prohibits. Cleanup of
    // daemon.json is owned by the successor process's reconcileExistingDaemon
    // path, which only removes the file after confirming the recorded pid is
    // actually dead.
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
        const needsBody = isWriteMethod(req.method);
        const body = needsBody ? await readBody(req) : undefined;
        const requestContext = requestContextFromHttpHeaders(req.headers, this.vaultDir, {
          expectedAuthToken: this.authToken,
        });
        // Long-running ops (move, vacuum) take a per-project pause in
        // `projects.toml`; while set, every writer for that project must
        // be refused. Reads stay open so the UI can still surface "this
        // project is paused (reason)".
        if (isWriteMethod(req.method) && requestContext.groveId) {
          const paused = isProjectPaused(requestContext.projectId);
          if (paused.paused) {
            const response = pausedErrorResponse(requestContext.projectId, paused);
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

    // No API route matched — serve static files (dashboard SPA)
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
      const info = readDaemonState(this.daemonStatePath);
      if (!info) return;
      info.sessions = sessions;
      writeDaemonState(this.daemonStatePath, info);
    } catch { /* daemon state may not exist during shutdown */ }
  }

  /**
   * Kill any existing daemon for this vault before taking over.
   * Prevents orphaned daemons when spawned from worktrees or plugin upgrades.
   * Must be called BEFORE `server.start()` so the old daemon releases the
   * canonical port.
   *
   * Delegates to `evictDaemonsForVault`, which also handles orphans that
   * hold the canonical port but aren't recorded in daemon.json.
   */
  async evictExistingDaemon(): Promise<void> {
    await evictDaemonsForVault(this.vaultDir, { logger: this.logger });
  }

  private writeDaemonJson(): void {
    const info = {
      pid: process.pid,
      port: this.port,
      command: process.execPath,
      started: new Date().toISOString(),
      sessions: [] as string[],
      version: this.version,
      auth_token: this.authToken,
    };
    writeDaemonState(this.daemonStatePath, info);
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
