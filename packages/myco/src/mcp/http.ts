import type http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Database } from '../db/client.js';
import { DaemonClient } from '../hooks/client.js';
import { createMycoTools } from '../tools/index.js';
import {
  ForeignGroveError,
  isCallerTenancy,
  requestContextFromHttpHeaders,
  resolveInboundProjectId,
  tryResolveRequestContextForVault,
  UnauthorizedRequestContextError,
  UnknownRequestContextError,
  type MycoRequestContext,
} from '../grove/request-context.js';
import { classifyRoute, refusalMcpBody } from '../host/routing.js';
import { handleAttachedRequest, proxyLoggerFrom, type HostProxyDeps } from '../daemon/host-proxy.js';
import { isOverlayRequest, servedGroveRefusal, type HostServeRuntime } from '../daemon/host-serve.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { createMcpProtocolServer } from './server.js';
import type { Logger } from '../daemon/logger.js';

export type StreamableMcpHttpHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

export interface StreamableMcpHttpHandlerOptions {
  client?: DaemonClient;
  /** Reuse the daemon's runtime cache so tool calls don't open per-call DB handles. */
  resolveDatabase?: (databasePath: string) => Database;
  /**
   * Optional structured logger. When provided, the protocol server logs
   * each /mcp tool dispatch (start, success, error) — closes the
   * observability gap from issue #288.
   */
  logger?: Logger;
  /**
   * Capture-side proxy deps threaded into `handleAttachedRequest` for attached
   * projects (transcript-drain flush + collect enqueue). This is the SECOND of
   * the two dispatch chokepoints C1 wires (the first is `daemon/server.ts`) —
   * both must pass the real dep or the flush-before-terminal-route guarantee
   * silently never fires for the surface routed through this one.
   */
  hostProxyDeps?: Partial<HostProxyDeps>;
  /**
   * Team Host serve enablement (Task 2.3), threaded so the served-grove
   * fail-closed filter (Task 2, `servedGroveRefusal`) can run at THIS
   * dispatch chokepoint too — chokepoint 2 of the dual-homed filter (the
   * first is `daemon/server.ts`'s router-route dispatch). `/mcp` bypasses
   * router dispatch entirely (a raw route), so it must independently gate an
   * overlay request's resolved Grove against `hostServe.servedGroveId`; a
   * single-homed filter would leave the full mixed-op MCP tool surface
   * (including `myco_spores`/`myco_plans` writes) open against any Grove the
   * host owns. `null`/omitted on a non-host daemon — the overlay branch below
   * never runs there (no overlay listener, so `isOverlayRequest` is always
   * false), so the filter is inert rather than misapplied.
   */
  hostServe?: HostServeRuntime | null;
}

/**
 * Build the JSON-RPC `legacy_vault` wire envelope. This is the HTTP-layer
 * translation of the shared tools-runtime tenancy policy: when no
 * caller-supplied (project/Grove) tenancy is available, the request must not
 * silently default to the bootstrap-anchor vault. Surfaced as a structured
 * 503 with a `legacy_vault` discriminator so MCP clients render a friendly
 * "this project hasn't been auto-registered yet" message instead of the
 * opaque `tool_call_failed` JSON-RPC error they'd otherwise get from the
 * shared runtime rejecting the call inside dispatch.
 */
function legacyVaultBody(message: string, vaultDir: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: -32004,
      message,
      data: { code: 'legacy_vault', vault_dir: vaultDir },
    },
    id: null,
  });
}

/**
 * Resolve the request context for this MCP-HTTP call, or translate a
 * non-caller / pre-Grove state into the `legacy_vault` wire error.
 *
 * The shared tools runtime (`createMycoTools`) is the single source of the
 * tenancy policy: it rejects any context whose `tenancySource` is not
 * `'caller'`. This pre-flight applies the *same* predicate at the transport
 * boundary so the rejection becomes a clean structured 503 rather than an
 * in-protocol `tool_call_failed` raised mid-dispatch. We do not re-implement
 * the policy — we read the resolved context's `tenancySource` (the value the
 * runtime checks) and translate it to the wire.
 *
 * A pre-Grove vault (no `project.toml` Grove id, no context headers) makes
 * `requestContextFromHttpHeaders` throw; `tryResolveRequestContextForVault`
 * gives us the friendly reason to return instead.
 */
function resolveRequestContextOrLegacy(
  req: http.IncomingMessage,
  vaultDir: string,
): { ok: true; requestContext: MycoRequestContext } | { ok: false; body: string } {
  let requestContext: MycoRequestContext;
  try {
    // G4: when the daemon has minted a bearer token (via env), enforce
    // the same context-switch gate the daemon's main HTTP server uses.
    requestContext = requestContextFromHttpHeaders(req.headers, vaultDir, {
      expectedAuthToken: process.env.MYCO_DAEMON_AUTH ?? null,
      // Inbound daemon resolution: a tool call must never resolve to (and
      // then open) a Grove served by the other daemon variant.
      enforceGroveOwnership: true,
    });
  } catch (err) {
    // Preserve the auth-gate contract: a context-switch without the
    // daemon-issued bearer token is an authorization failure, not a
    // legacy-vault soft-fail. Re-throw so the caller's existing handling
    // applies.
    if (err instanceof UnauthorizedRequestContextError) throw err;
    // Same for ownership: a Grove that lives in another daemon's home is a
    // 403 foreign_grove refusal, never the misleading legacy_vault 503.
    if (err instanceof ForeignGroveError) throw err;
    // A named (Grove, project) that does not exist in this daemon's home is
    // unknown tenancy (404), never the misleading legacy_vault 503 — a
    // foreign-home Grove is unknown to this daemon, not a pre-Grove vault.
    if (err instanceof UnknownRequestContextError) throw err;
    // Pre-Grove vault: the resolver threw because there's no Grove project
    // id to bind to. Surface the soft-fail reason rather than a 500.
    const result = tryResolveRequestContextForVault(vaultDir);
    const reason = result.kind === 'legacy'
      ? result.reason
      : `No authorized project tenancy for vault ${vaultDir}.`;
    return { ok: false, body: legacyVaultBody(reason, vaultDir) };
  }

  if (!isCallerTenancy(requestContext)) {
    // The request resolved to a synthesized (anchor-derived) tenancy — the
    // shared runtime would reject this at dispatch. Translate to the
    // legacy_vault wire contract up front.
    return {
      ok: false,
      body: legacyVaultBody(
        'This Myco project has no caller-supplied tenancy (it has not been auto-registered yet). '
        + 'Open the dashboard and commit Myco config to this project from the Symbionts page.',
        vaultDir,
      ),
    };
  }

  return { ok: true, requestContext };
}

export function createStreamableMcpHttpHandler(
  vaultDir: string,
  options: StreamableMcpHttpHandlerOptions = {},
): StreamableMcpHttpHandler {
  const client = options.client ?? new DaemonClient(vaultDir);
  return async (req, res) => {
    // Team Host chokepoint 2: the raw /mcp route bypasses route dispatch and
    // resolves its own context, so the attach short-circuit lives here too, as
    // per-tool-call tenancy. It runs BEFORE resolveRequestContextOrLegacy and
    // before any local Grove/DB resolution — an attached project must never open
    // a local Grove DB. A non-attached project (the common case) falls through
    // after a single empty-set registry probe.
    //
    // A request that ARRIVED on this daemon's overlay listener has already been
    // routed to its host (this daemon); it is served LOCALLY and must never be
    // re-classified/re-proxied — skipping attach classification for overlay
    // requests makes a circular proxy structurally impossible (mirrors the router
    // chokepoint in daemon/server.ts). handleOverlayRequest already validated the
    // host bearer and stamped the local bearer, so the resolution below succeeds.
    if (!isOverlayRequest(req)) {
      try {
        const { projectId } = resolveInboundProjectId(req.headers, vaultDir, {
          expectedAuthToken: process.env.MYCO_DAEMON_AUTH ?? null,
        });
        const decision = classifyRoute({ method: req.method ?? 'POST', pathname: '/mcp', projectId });
        if (decision.kind === 'degraded' || decision.kind === 'config_locked') {
          res.statusCode = decision.refusal.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(refusalMcpBody(decision.refusal));
          return;
        }
        if (decision.kind === 'remote') {
          await handleAttachedRequest(req, res, decision.target, decision.classification, {
            ...options.hostProxyDeps,
            logger: options.logger ? proxyLoggerFrom(options.logger, LOG_KINDS.SERVER_ERROR) : undefined,
          });
          return;
        }
      } catch (err) {
        // enforceContextSwitchAuth rejected the local bearer — same 401
        // `unauthorized_context_switch` contract the local resolution path returns.
        if (err instanceof UnauthorizedRequestContextError) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'unauthorized_context_switch', message: err.message }));
          return;
        }
        throw err;
      }
    }

    let resolved: ReturnType<typeof resolveRequestContextOrLegacy>;
    try {
      resolved = resolveRequestContextOrLegacy(req, vaultDir);
    } catch (err) {
      // A context-switch without the daemon-issued bearer token is an
      // authorization failure. Translate it to the same 401
      // `unauthorized_context_switch` contract the main HTTP server path
      // returns (daemon/server.ts) so MCP callers get a clear 401 instead
      // of the generic raw-route -32603/500 that an uncaught throw becomes.
      if (err instanceof UnauthorizedRequestContextError) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'unauthorized_context_switch', message: err.message }));
        return;
      }
      // Grove served by the other daemon variant: surface the same 403
      // `foreign_grove` contract the main HTTP path returns so MCP callers
      // see the claim hint instead of a generic -32603/500.
      if (err instanceof ForeignGroveError) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: 'foreign_grove',
          message: err.message,
          grove_id: err.groveId,
        }));
        return;
      }
      // A named (Grove, project) absent from this daemon's home: surface
      // the same 404 `unknown_tenancy` contract the main HTTP server path
      // returns (daemon/server.ts) instead of a misleading legacy_vault 503.
      if (err instanceof UnknownRequestContextError) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'unknown_tenancy', message: err.message }));
        return;
      }
      throw err;
    }
    if (!resolved.ok) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(resolved.body);
      return;
    }
    const { requestContext } = resolved;

    // Team Host served-grove filter (Task 2), chokepoint 2 of 2 (see
    // `daemon/server.ts` for chokepoint 1). `/mcp` is a raw route — it never
    // passes through the router's chokepoint-1 check — so it must
    // independently refuse an overlay request whose resolved Grove is not
    // THE one Grove this host serves, immediately after context resolution
    // and before any tool/protocol dispatch.
    if (isOverlayRequest(req)) {
      const groveRefusal = options.hostServe
        ? servedGroveRefusal(options.hostServe, requestContext.groveId)
        // Unreachable in practice (isOverlayRequest only marks requests when
        // the daemon's overlay listener — which requires hostServe — is
        // what admitted them), but fail closed rather than dispatch.
        : { status: 503, body: { error: 'host_serve_unavailable' } };
      if (groveRefusal) {
        res.statusCode = groveRefusal.status;
        res.setHeader('Content-Type', 'application/json');
        if (groveRefusal.headers) {
          for (const [key, value] of Object.entries(groveRefusal.headers)) res.setHeader(key, value);
        }
        res.end(JSON.stringify(groveRefusal.body));
        return;
      }
    }

    const tools = createMycoTools(vaultDir, client, {
      requestContext,
      resolveDatabase: options.resolveDatabase,
    });
    const server = createMcpProtocolServer(tools, {
      logger: options.logger,
      sessionId: requestContext.sessionId ?? null,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}
