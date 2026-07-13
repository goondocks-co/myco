/**
 * The external read-only MCP listener (server-mode design spec §7) — a
 * dedicated, purpose-bound `http.createServer` that serves ONLY the
 * allowlist-filtered MCP handler on `/mcp`. Every other path is 404, and a
 * request is 401ed before any tool dispatch unless it presents the
 * external MCP token (a THIRD credential, distinct from the loopback daemon
 * token and the member serve-bearer — `HOST_EXTERNAL_MCP_TOKEN_SECRET`).
 *
 * This listener intentionally does NOT reuse `daemon/server.ts`'s
 * `handleRequest` (the router + raw-route dispatcher that also serves
 * `/health`, every `/api/*` route, and enrollment) — sharing that pipeline
 * would expose the whole daemon control surface on a Funnel-fronted public
 * URL. It also does not reuse `mcp/http.ts`'s `createStreamableMcpHttpHandler`
 * (the daemon's own `/mcp`, which pulls in Team Host attach/proxy
 * classification): a request here always resolves LOCALLY, against exactly
 * the one Grove this host serves.
 *
 * It DOES reuse the same pure, already-reviewed building blocks the local
 * `/mcp` chokepoints use for tenancy resolution and served-grove scoping
 * (`requestContextFromHttpHeaders`, `servedGroveRefusal`) and the same
 * shared tool runtime (`createMycoTools`) every caller dispatches through —
 * `mcp/external-surface.ts`'s allowlist wrapper is the only thing narrowing
 * what is reachable here.
 *
 * Binding is opt-in and persisted (`daemon.external_mcp` config): the
 * `PUT /api/team/external-mcp/toggle` route (`api/team-config.ts`) calls
 * `bind`/`unbind` live, and `daemon/main.ts` calls `bind` again at boot when
 * the toggle is already on, so a restart re-binds before Funnel traffic can
 * hit a dead port.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Database } from '../db/client.js';
import { DaemonClient } from '../hooks/client.js';
import { createMycoTools } from '../tools/index.js';
import {
  ForeignGroveError,
  isCallerTenancy,
  requestContextFromHttpHeaders,
  UnauthorizedRequestContextError,
  UnknownRequestContextError,
  type MycoRequestContext,
} from '../grove/request-context.js';
import { servedGroveRefusal, type HostServeRuntime } from './host-serve.js';
import { createMcpProtocolServer } from '../mcp/server.js';
import { createExternalTools } from '../mcp/external-surface.js';
import { readSecrets } from '../config/secrets.js';
import { resolveMycoHome } from '../grove/paths.js';
import { HOST_EXTERNAL_MCP_TOKEN_SECRET } from '../constants.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { applyDaemonHttpServerLimits, DAEMON_HTTP_LISTEN_BACKLOG, gracefullyCloseHttpServer } from './server.js';
import type { Logger } from './logger.js';

const EXTERNAL_MCP_PATH = '/mcp';
/** Same fast-shutdown grace window the loopback/overlay listeners use. */
const EXTERNAL_MCP_STOP_GRACE_MS = 2_000;

interface ExternalListenerLogger {
  info(kind: string, message: string, data?: Record<string, unknown>): void;
  warn(kind: string, message: string, data?: Record<string, unknown>): void;
}

export interface ExternalMcpListenerDeps {
  /** The daemon's bootstrap-anchor vault dir — SAME argument `daemon/main.ts`
   *  threads into `createStreamableMcpHttpHandler` for the loopback `/mcp`.
   *  Used to construct the internal `DaemonClient` (loopback API calls the
   *  shared tool runtime makes) and as the fallback/legacy vault for header
   *  resolution. */
  vaultDir: string;
  /** This machine's resolved host-serve runtime, or `null` when this
   *  machine is not a Team Host. Resolved once at daemon boot — same value
   *  `daemon/main.ts` threads into `DaemonServer` and the team-write route
   *  deps, so this listener's served-grove check can never drift from the
   *  overlay's. `null` fails closed (503) rather than dispatching; in
   *  practice the toggle route already refuses `not_serving` before a bind
   *  is ever attempted, so a bound listener with a null `hostServe` should
   *  not occur outside a race with a config change mid-request. */
  hostServe: HostServeRuntime | null;
  resolveDatabase?: (databasePath: string) => Database;
  logger?: Logger;
  mycoHome?: string;
  /** Overrides the internal `DaemonClient` the shared tool runtime uses for
   *  its own loopback API calls (sessions/skills/spores/plans list-get all
   *  round-trip through `/api/*` on this same daemon). Defaults to
   *  `new DaemonClient(vaultDir)`, exactly matching the loopback `/mcp`
   *  handler's default (`mcp/http.ts`). Tests inject a stub. */
  client?: DaemonClient;
}

/**
 * Constant-time token compare (server-mode design spec §7). Presented and
 * expected values are first reduced to fixed-length SHA-256 digests, THEN
 * compared with `crypto.timingSafeEqual` — hashing first means a length
 * mismatch between the presented and expected token can never short-circuit
 * the comparison (both digests are always 32 bytes), which a direct
 * `timingSafeEqual(Buffer.from(a), Buffer.from(b))` call cannot guarantee
 * for unequal-length inputs (it throws instead of comparing). This is the
 * ONE token-compare primitive Task 8 left unbuilt — spec §7 requires it and
 * entropy is the sole brute-force defense behind an internet-scannable
 * Funnel URL.
 */
export function constantTimeTokenEqual(presented: string, expected: string): boolean {
  const presentedDigest = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(presentedDigest, expectedDigest);
}

function parseBearer(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * The dedicated external MCP listener. One instance lives for the daemon
 * process's lifetime; `bind`/`unbind` are called live by the toggle route
 * and at boot (when persisted config says the toggle is on).
 */
export class ExternalMcpListener {
  private readonly deps: ExternalMcpListenerDeps;
  private readonly logger: ExternalListenerLogger;
  private server: http.Server | null = null;
  private boundPort = 0;

  constructor(deps: ExternalMcpListenerDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? { info: () => {}, warn: () => {} };
  }

  get isBound(): boolean {
    return this.server !== null;
  }

  get port(): number {
    return this.boundPort;
  }

  /** Current raw token, or null when none has ever been minted. Re-read
   *  from disk on every check (never cached) so a rotate takes effect on
   *  the very next request without a restart. */
  private currentToken(): string | null {
    const mycoHome = this.deps.mycoHome ?? resolveMycoHome();
    const value = readSecrets(mycoHome)[HOST_EXTERNAL_MCP_TOKEN_SECRET];
    return value && value.trim() ? value.trim() : null;
  }

  /**
   * Bind the listener on 127.0.0.1:`port`. Idempotent — calling `bind`
   * while already bound on the SAME port is a no-op; a different port
   * unbinds first. Never throws: a bind failure (port in use) resolves
   * `{ ok: false }` with the reason so a caller (the toggle route, or boot
   * re-bind) can report it without crashing the daemon.
   */
  async bind(port: number): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
    if (this.server && this.boundPort === port) return { ok: true, port: this.boundPort };
    if (this.server) await this.unbind();

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.logger.warn(LOG_KINDS.EXTERNAL_MCP, 'External MCP listener request handler failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          try {
            if (!res.headersSent) writeJson(res, 500, { error: 'internal_error' });
            else res.end();
          } catch { /* socket already gone */ }
        });
      });
      // Never a WebSocket surface — destroy any upgrade attempt outright,
      // same posture as the Team Host overlay listener.
      server.on('upgrade', (_req, socket) => { try { socket.destroy(); } catch { /* already gone */ } });
      applyDaemonHttpServerLimits(server);

      const onBindError = (err: NodeJS.ErrnoException) => {
        this.logger.warn(LOG_KINDS.EXTERNAL_MCP, 'External MCP listener failed to bind', {
          port, error: err.message, code: err.code ?? null,
        });
        try { server.close(); } catch { /* not listening */ }
        resolve({ ok: false, error: err.message });
      };
      server.once('error', onBindError);

      server.listen(port, '127.0.0.1', DAEMON_HTTP_LISTEN_BACKLOG, () => {
        server.removeListener('error', onBindError);
        server.on('error', (err) => {
          this.logger.warn(LOG_KINDS.EXTERNAL_MCP, 'External MCP listener socket error', { error: (err as Error).message });
        });
        const addr = server.address() as { port: number };
        this.server = server;
        this.boundPort = addr.port;
        this.logger.info(LOG_KINDS.EXTERNAL_MCP, 'External MCP listener bound', { port: this.boundPort });
        resolve({ ok: true, port: this.boundPort });
      });
    });
  }

  async unbind(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    if (!server) return;
    await gracefullyCloseHttpServer(server, { gracePeriodMs: EXTERNAL_MCP_STOP_GRACE_MS });
    this.logger.info(LOG_KINDS.EXTERNAL_MCP, 'External MCP listener unbound');
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    // Fail closed on the transport surface FIRST — everything except /mcp
    // is indistinguishable from a route that was never registered. No
    // /health, no /api/*, no enrollment on the public URL.
    if (pathname !== EXTERNAL_MCP_PATH) {
      writeJson(res, 404, { error: 'not_found' });
      return;
    }

    // Token gate BEFORE any handler work (constant-time compare, spec §7).
    const expected = this.currentToken();
    const presented = parseBearer(req.headers.authorization);
    if (!expected || !presented || !constantTimeTokenEqual(presented, expected)) {
      writeJson(res, 401, { error: 'unauthorized', message: 'A valid external MCP token is required.' });
      return;
    }

    let requestContext: MycoRequestContext;
    try {
      requestContext = requestContextFromHttpHeaders(req.headers, this.deps.vaultDir, {
        // The external token above is this listener's own trust boundary;
        // it does not additionally require the loopback daemon bearer on
        // context-switch headers (a no-op when no daemon token is configured
        // — same behavior the loopback /mcp gate falls back to for non-daemon
        // callers).
        expectedAuthToken: null,
        enforceGroveOwnership: true,
      });
    } catch (err) {
      if (err instanceof UnauthorizedRequestContextError) {
        writeJson(res, 401, { error: 'unauthorized_context_switch', message: err.message });
        return;
      }
      if (err instanceof ForeignGroveError) {
        writeJson(res, 403, { error: 'foreign_grove', message: err.message, grove_id: err.groveId });
        return;
      }
      if (err instanceof UnknownRequestContextError) {
        writeJson(res, 404, { error: 'unknown_tenancy', message: err.message });
        return;
      }
      throw err;
    }

    // The served-grove filter (Task 2's proven fail-closed gate, reused
    // here as this listener's own chokepoint): refuses unless the resolved
    // Grove is EXACTLY the one this host serves — never "any Grove this
    // host owns". `hostServe` is null only in the unreachable case noted on
    // the field's docstring; fail closed rather than dispatch.
    if (!this.deps.hostServe) {
      writeJson(res, 503, { error: 'host_serve_unavailable' });
      return;
    }
    const refusal = servedGroveRefusal(this.deps.hostServe, requestContext.groveId);
    if (refusal) {
      writeJson(res, refusal.status, refusal.body);
      return;
    }

    if (!isCallerTenancy(requestContext)) {
      writeJson(res, 503, {
        error: 'legacy_vault',
        message: 'This request supplied no caller tenancy (x-myco-grove-id/x-myco-project-id headers). '
          + 'External MCP callers must name the served Grove and a project registered in it.',
      });
      return;
    }

    const client = this.deps.client ?? new DaemonClient(this.deps.vaultDir);
    const tools = createExternalTools(createMycoTools(this.deps.vaultDir, client, {
      requestContext,
      resolveDatabase: this.deps.resolveDatabase,
    }));
    const server = createMcpProtocolServer(tools, {
      logger: this.deps.logger,
      sessionId: requestContext.sessionId ?? null,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
}

// ---------------------------------------------------------------------------
// Tailscale Funnel — injectable runner seam (live Funnel is rig-validated in
// Task 12; the runner itself is not unit-testable, so tests inject a stub).
// ---------------------------------------------------------------------------

export type FunnelRunner = (port: number, on: boolean) => Promise<{ ok: boolean; detail: string }>;

/** Shells out to `tailscale funnel <port> [on|off]`. The real runner used in
 *  production; every test injects a stub instead. */
export const defaultFunnelRunner: FunnelRunner = async (port, on) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync('tailscale', ['funnel', String(port), on ? 'on' : 'off']);
    return { ok: true, detail: `tailscale funnel ${port} ${on ? 'on' : 'off'}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
};
