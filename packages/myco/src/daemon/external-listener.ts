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
 * Tenancy is derived by this listener, never required of the caller (server-
 * mode design spec §1: groves are never team-facing, a fortiori never
 * external-facing). The Grove is ALWAYS `hostServe.servedGroveId` — a caller
 * sends NO `x-myco-grove-id`/`x-myco-project-id` headers at all and still
 * dispatches successfully, with grove-wide semantics mirroring the retired
 * worker contract (`packages/myco-team/worker/src/mcp/server.ts`): each
 * allowlisted tool's own optional `project_id` ARGUMENT (the existing
 * grove-internal scope-pivot every MCP tool already accepts, `tools/
 * call-context.ts`) remains the project selector. Tenancy headers, if
 * present, are validated instead of trusted: any `x-myco-grove-id` that
 * isn't the served grove, or any `x-myco-project-id` that isn't registered
 * in it, refuses with the SAME uniform 404 this transport always uses for
 * "not reachable here" — collapsing what would otherwise be a foreign-vs-
 * unknown-vs-not-served existence oracle into one indistinguishable
 * refusal. A hostile header can never redirect resolution to another Grove:
 * `servedGroveRefusal` still runs as defense in depth after resolution.
 *
 * Runtime ownership is controlled by `ExternalMcpContainmentAuthority`.
 * Public activation is unavailable; persisted or interrupted activation
 * state is driven to confirmed Funnel-off before this listener is released.
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
  readHeader,
  REQUEST_CONTEXT_HEADERS,
  requestContextFromHttpHeaders,
  UnauthorizedRequestContextError,
  UnknownRequestContextError,
  type MycoRequestContext,
} from '../grove/request-context.js';
import { servedGroveRefusal, type HostServeRuntime, type OverlayGateRefusal } from './host-serve.js';
import { createMcpProtocolServer } from '../mcp/server.js';
import { createExternalTools } from '../mcp/external-surface.js';
import { readSecrets } from '../config/secrets.js';
import { resolveMycoHome } from '../grove/paths.js';
import { HOST_EXTERNAL_MCP_TOKEN_SECRET } from '../constants.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { applyDaemonHttpServerLimits, DAEMON_HTTP_LISTEN_BACKLOG, gracefullyCloseHttpServer } from './server.js';
import type { Logger } from './logger.js';
import type { FunnelOffRunner } from './external-mcp-containment.js';

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
 * process lifetime so containment can retain or release its port safely.
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

      try {
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
      } catch (err) {
        // `server.listen` throws SYNCHRONOUSLY (never emits 'error') for some
        // invalid inputs — e.g. a port outside 0-65535. Uncaught, that throw
        // would surface as a REJECTED promise from `bind`, breaking the
        // documented "never throws" contract (this method's own docstring,
        // and every caller — the toggle route, boot re-bind — that awaits it
        // expecting a resolved `{ ok: false }` on failure, never a throw).
        server.removeListener('error', onBindError);
        try { server.close(); } catch { /* not listening */ }
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(LOG_KINDS.EXTERNAL_MCP, 'External MCP listener failed to bind (synchronous)', { port, error: message });
        resolve({ ok: false, error: message });
      }
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

    // `hostServe` is null only in the unreachable case noted on the field's
    // docstring; fail closed rather than dispatch. Checked BEFORE tenancy
    // resolution — the served Grove id is the default this listener derives
    // tenancy from, so there is nothing to resolve without it.
    const hostServe = this.deps.hostServe;
    if (!hostServe?.servedGroveId) {
      writeJson(res, 503, { error: 'host_serve_unavailable' });
      return;
    }
    const servedGroveId = hostServe.servedGroveId;

    // A single uniform refusal reused for EVERY "this doesn't resolve to the
    // served Grove" reason — genuinely unknown grove/project id, a grove_id
    // that names a real Grove owned by ANOTHER daemon, and a grove_id that
    // names a real Grove this daemon owns but does not serve all collapse
    // into the SAME status/body. This is deliberate: distinguishing them
    // would let a caller probe which Grove ids exist on this host at all
    // (the reviewed 403-vs-404 grove-existence oracle). `hostServe.
    // servedGroveId` is already known truthy (checked above), so
    // `servedGroveRefusal`'s null-runtime branch can never fire and this
    // always returns a real refusal — the `!` reflects that invariant,
    // not an unchecked assumption.
    const servedGroveOnlyRefusal = (): OverlayGateRefusal => servedGroveRefusal(hostServe, null)!;

    // Groves are never external-facing (server-mode design spec §1): the
    // caller does not need to name a Grove at all. When they don't, this
    // listener supplies the served Grove itself. When they DO supply
    // `x-myco-grove-id`, it is validated (must equal the served Grove)
    // rather than trusted — never resolved against the registry first,
    // so a foreign/unknown grove_id can never distinguish "exists
    // elsewhere" from "doesn't exist" before this listener even looks.
    const presentedGroveId = readHeader(req.headers, REQUEST_CONTEXT_HEADERS.groveId);
    if (presentedGroveId !== undefined && presentedGroveId !== servedGroveId) {
      const refusal = servedGroveOnlyRefusal();
      writeJson(res, refusal.status, refusal.body);
      return;
    }
    const headers: http.IncomingHttpHeaders = presentedGroveId === undefined
      ? { ...req.headers, [REQUEST_CONTEXT_HEADERS.groveId]: servedGroveId }
      : req.headers;

    let requestContext: MycoRequestContext;
    try {
      requestContext = requestContextFromHttpHeaders(headers, this.deps.vaultDir, {
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
      // ForeignGroveError (a real Grove, owned by another daemon) and
      // UnknownRequestContextError (no such Grove/project, or a project not
      // registered in the served Grove) both fold into the SAME uniform
      // refusal as an out-of-scope grove_id header above — never a distinct
      // 403, never the caller's own id echoed back.
      if (err instanceof ForeignGroveError || err instanceof UnknownRequestContextError) {
        const refusal = servedGroveOnlyRefusal();
        writeJson(res, refusal.status, refusal.body);
        return;
      }
      throw err;
    }

    // The served-grove filter (Task 2's proven fail-closed gate, reused
    // here as this listener's own chokepoint): refuses unless the resolved
    // Grove is EXACTLY the one this host serves — never "any Grove this
    // host owns". Defense in depth: every path above already enforces this,
    // so this should never actually fire, but a hostile header must never
    // be able to redirect resolution to another Grove even if a bug
    // upstream let a mismatched groveId through.
    const refusal = servedGroveRefusal(hostServe, requestContext.groveId);
    if (refusal) {
      writeJson(res, refusal.status, refusal.body);
      return;
    }

    // Defense in depth, not a live branch: every path above stamps
    // `tenancySource: 'caller'` (either the caller's own headers or this
    // listener's served-grove default), so this can never actually be
    // false. Kept because the cost is one boolean check and the invariant
    // is exactly what makes the tool-runtime's own `requireCallerTenancy`
    // gate (`tools/index.ts`) redundant-safe here.
    if (!isCallerTenancy(requestContext)) {
      const legacyRefusal = servedGroveOnlyRefusal();
      writeJson(res, legacyRefusal.status, legacyRefusal.body);
      return;
    }

    const client = this.deps.client ?? new DaemonClient(this.deps.vaultDir);
    const tools = createExternalTools(createMycoTools(this.deps.vaultDir, client, {
      requestContext,
      resolveDatabase: this.deps.resolveDatabase,
      callContextConstraint: { allowedGroveId: servedGroveId },
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
// Tailscale Funnel containment runner.
// ---------------------------------------------------------------------------

export interface TailscaleCommandResult {
  stdout: string;
}

export type TailscaleCommandRunner = (
  args: string[],
) => Promise<TailscaleCommandResult>;

interface FunnelWebSelector {
  hostPort: string;
  publicPort: number;
  mount: string;
  proxy: string;
}

interface FunnelStatusSnapshot {
  selectors: FunnelWebSelector[];
  allowedHostPorts: Set<string>;
}

function mapping(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function publicPortFromHostPort(hostPort: string): number {
  const match = hostPort.match(/:(\d+)$/);
  const port = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid Funnel host-port selector: ${hostPort}`);
  }
  return port;
}

function proxyTargetsLocalPort(proxy: string, targetPort: number): boolean {
  try {
    const parsed = new URL(proxy);
    return (
      parsed.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      && Number(parsed.port) === targetPort
    );
  } catch {
    return false;
  }
}

function readFunnelStatus(
  rawStatus: string,
  targetPort: number,
): FunnelStatusSnapshot {
  const parsed = JSON.parse(rawStatus) as unknown;
  const config = mapping(parsed, 'Funnel status');
  const allowFunnel = mapping(config.AllowFunnel, 'Funnel status AllowFunnel');
  const web = mapping(config.Web, 'Funnel status Web');
  const tcp = mapping(config.TCP, 'Funnel status TCP');
  const selectors: FunnelWebSelector[] = [];
  const allowedHostPorts = new Set<string>();

  for (const [hostPort, allowed] of Object.entries(allowFunnel)) {
    if (typeof allowed !== 'boolean') {
      throw new Error(`Funnel status AllowFunnel.${hostPort} must be boolean`);
    }
    if (!allowed) continue;
    allowedHostPorts.add(hostPort);
    const webConfig = web[hostPort];
    if (webConfig === undefined) continue;
    const handlers = mapping(
      mapping(webConfig, `Funnel status Web.${hostPort}`).Handlers,
      `Funnel status Web.${hostPort}.Handlers`,
    );
    const publicPort = publicPortFromHostPort(hostPort);
    const tcpHandler = mapping(
      tcp[String(publicPort)],
      `Funnel status TCP.${publicPort}`,
    );
    if (tcpHandler.HTTPS !== true) {
      throw new Error(`Funnel status TCP.${publicPort} is not an HTTPS handler`);
    }
    for (const [mount, rawHandler] of Object.entries(handlers)) {
      const handler = mapping(
        rawHandler,
        `Funnel status Web.${hostPort}.Handlers.${mount}`,
      );
      if (handler.Proxy === undefined) continue;
      if (typeof handler.Proxy !== 'string') {
        throw new Error(`Funnel handler proxy at ${hostPort}${mount} must be a string`);
      }
      if (proxyTargetsLocalPort(handler.Proxy, targetPort)) {
        selectors.push({
          hostPort,
          publicPort,
          mount,
          proxy: handler.Proxy,
        });
      }
    }
  }

  return { selectors, allowedHostPorts };
}

/**
 * Converts each affected host-port to tailnet-only Serve before removing the
 * handler that targets the known local port, then verifies both facts.
 */
export function createFunnelOffRunner(
  runCommand: TailscaleCommandRunner,
): FunnelOffRunner {
  return async (port) => {
    try {
      const before = await runCommand(['funnel', 'status', '--json']);
      const beforeStatus = readFunnelStatus(before.stdout, port);
      const selectors = beforeStatus.selectors;
      for (const selector of selectors) {
        await runCommand([
          'serve',
          '--bg',
          '--yes',
          `--https=${selector.publicPort}`,
          `--set-path=${selector.mount}`,
          selector.proxy,
        ]);
        await runCommand([
          'serve',
          '--bg',
          '--yes',
          `--https=${selector.publicPort}`,
          `--set-path=${selector.mount}`,
          'off',
        ]);
      }
      const after = selectors.length > 0
        ? await runCommand(['funnel', 'status', '--json'])
        : before;
      const afterStatus = readFunnelStatus(after.stdout, port);
      const remainingAllowedHostPorts = new Set(
        selectors
          .map((selector) => selector.hostPort)
          .filter((hostPort) => afterStatus.allowedHostPorts.has(hostPort)),
      );
      if (afterStatus.selectors.length > 0 || remainingAllowedHostPorts.size > 0) {
        return {
          ok: false,
          detail: remainingAllowedHostPorts.size > 0
            ? `public Funnel remains enabled for ${[...remainingAllowedHostPorts].join(', ')}`
            : `public Funnel still targets local port ${port}`,
        };
      }
      return {
        ok: true,
        detail: `confirmed no public Funnel handler targets local port ${port}`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export const defaultFunnelOffRunner: FunnelOffRunner = createFunnelOffRunner(async (args) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync('tailscale', args, {
    timeout: 10_000,
    encoding: 'utf-8',
  });
  return { stdout };
});
