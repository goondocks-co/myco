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
import { readDaemonState, removeDaemonState, writeDaemonState } from './service-state.js';
import { vaultDbPath, withDatabase, type Database } from '../db/client.js';
import { GroveRuntimeCache } from './grove-runtime-cache.js';

const DEFAULT_STATUS = 200;

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

      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server!.address() as { port: number };
        this.port = addr.port;
        this.writeDaemonJson();
        this.logger.info(LOG_KINDS.DAEMON_PORT, 'Server started', { port: this.port, dashboard: `http://localhost:${this.port}/` });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.removeDaemonJson();
      if (this.server) {
        this.server.close(() => {
          this.closeRequestDatabases();
          this.logger.info(LOG_KINDS.DAEMON_START, 'Server stopped');
          resolve();
        });
      } else {
        this.closeRequestDatabases();
        resolve();
      }
    });
  }

  private registerDefaultRoutes(): void {
    this.registerRoute('GET', '/health', async () => ({
      body: {
        myco: true,
        version: this.version,
        pid: process.pid,
        uptime: process.uptime(),
      },
    }));
    this.registerRoute('GET', '/api/version', async () => ({
      body: { version: this.version },
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
        const needsBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';
        const body = needsBody ? await readBody(req) : undefined;
        const requestContext = requestContextFromHttpHeaders(req.headers, this.vaultDir, {
          expectedAuthToken: this.authToken,
        });
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

    if (pathname.startsWith('/api/') || pathname === '/health') {
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
            const raw = await fs.promises.readFile(result.filePath, 'utf-8');
            const injected = injectDashboardBootstrap(raw, this.authToken);
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
    if (pathname.startsWith('/api/') || pathname === '/health') return false;

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
    if (pathname.startsWith('/api/') || pathname === '/health') {
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

  private removeDaemonJson(): void {
    removeDaemonState(this.daemonStatePath, process.pid);
  }
}

/**
 * Inject the daemon-issued bearer token into the dashboard HTML at serve
 * time so the browser-side `fetchJson` wrapper can attach `x-myco-auth`
 * to context-switching API calls. Without this the `/api/stats` endpoint
 * (used by the Dashboard) rejects context-aware URLs like
 * `/g/<grove-slug>/p/<project-slug>` with `unauthorized_context_switch`.
 *
 * The token is same-origin-only (the daemon binds 127.0.0.1) and is
 * regenerated each process start, so embedding it in HTML is consistent
 * with the threat model already established for `daemon.json`.
 */
function injectDashboardBootstrap(html: string, authToken: string): string {
  // JSON-stringify defensively — a hex-encoded random token never contains
  // </script> or quote characters, but keep the shape robust against future
  // token formats.
  const safeToken = JSON.stringify(authToken);
  const bootstrap = `<script>window.__MYCO_AUTH__=${safeToken};</script>`;
  return html.replace('</head>', `${bootstrap}</head>`);
}

/**
 * Generate a fresh per-daemon-process bearer token. 32 random bytes
 * encoded as hex gives 256 bits of entropy — same shape as the
 * MCP/team-sync tokens the worker uses. Exported via env so spawned
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

  const method = (req.method ?? '').toUpperCase();
  const isMutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (!isMutating) return null;

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
