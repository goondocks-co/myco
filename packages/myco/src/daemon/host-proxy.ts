/**
 * Team Host — the member→host proxy forwarder (byte-opaque relay).
 *
 * `handleAttachedRequest` is the seam both inbound dispatch chokepoints
 * (`daemon/server.ts` router path, `mcp/http.ts` raw `/mcp` path) hand a
 * `serve`/`collect` request to once `classifyRoute` has resolved the project as
 * attached. It is invoked BEFORE the request body is read (server.ts) and before
 * any local Grove/DB resolution, so the forwarder can pipe the raw request
 * stream straight to the host. It never opens a local Grove DB — the
 * never-materialize invariant (routing-layer §1.1) holds here structurally.
 *
 * The relay is byte-opaque in both directions (routing-layer §2). It does NOT
 * parse the request or response body, with exactly two sanctioned, minimal
 * exceptions, each documented at its call site:
 *   1. COLLECT routes read a copy of the request body to append it to the local
 *      collector buffer (`resolveProjectBufferDir`, DB-free) before forwarding —
 *      the bytes forwarded to the host are still the originals, untouched — and
 *      synthesize the member's OWN `{ok,persisted:false,buffered}` ack
 *      rather than relaying the host response (routing-layer §3.1).
 *   2. The `/mcp` path peeks the JSON-RPC envelope's tool name + operation
 *      selector to degrade Canopy tool calls (the capability-off moat that must
 *      not cross the wire). This is the ONE surface where the member inspects
 *      the `/mcp` request envelope; it is confined to the operation selector
 *      (`op`/`type`), never data arguments (routing-layer §4, scope-map §6.1).
 *
 * Streaming is one uniform code path: always pipe the upstream response through
 * unbuffered, which correctly handles both the buffered-JSON endpoints and the
 * `/mcp` chunked/SSE case with no special-casing. Client disconnect tears down
 * the upstream leg both ways.
 */
import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';

import {
  HOST_MIN_COMPAT_VERSION,
  HOST_PROTOCOL_HEADER,
  HOST_PROTOCOL_VERSION,
  HOST_PROXY_BODY_TIMEOUT_MS,
  HOST_PROXY_CONNECT_TIMEOUT_MS,
  HOST_PROXY_HEADERS_TIMEOUT_MS,
  HOST_PROXY_MAX_BUFFERED_BODY_BYTES,
  HOST_PROXY_MCP_IDLE_TIMEOUT_MS,
  REFUSAL_LOG_THROTTLE_INTERVAL_MS,
} from '../constants.js';
import { EventBuffer } from '../capture/buffer.js';
import { stampCollectRoute } from '../capture/collect-buffer-route.js';
import { ensureEventId } from '../capture/event-id.js';
import { getMachineId } from '../machine-id.js';
import { resolveProjectBufferDir } from '../grove/paths.js';
import { parseHostUrl } from '../host/host-url.js';
import { REQUEST_CONTEXT_AUTH_HEADER, REQUEST_CONTEXT_HEADERS } from '../grove/request-context.js';
import { TOOL_CORTEX, TOOL_SEARCH } from '../tools/definitions.js';
import { shouldLogOncePerInterval } from './log-throttle.js';
import {
  hostedCapabilityUnavailable,
  refusalMcpBody,
  type RemoteTarget,
  type RouteClassification,
  type RouteStamp,
} from '../host/routing.js';

/** The three session-boundary capture routes that trigger transcript mining on
 *  the host; the member flushes its pending transcript push-queue before
 *  forwarding any of them so the host mines current bytes (routing-layer §2.1,
 *  capture-push §5.3). Keyed on the PATH, never the body. */
const FLUSH_BEFORE_FORWARD_ROUTES = new Set([
  '/events/stop',
  '/sessions/register',
  '/sessions/unregister',
]);

/** Hop-by-hop request headers the proxy never forwards (it re-computes them for
 *  the upstream leg). `authorization` + the local `x-myco-auth` are stripped so
 *  the LOCAL bearer never leaks to the host; the HOST bearer is attached fresh.
 *
 *  `origin`, `referer`, and `cookie` are stripped because this hop is
 *  server-to-server, not browser-to-server: the member has already enforced
 *  its OWN browser-facing auth/origin policy (the loopback CSRF gate) before
 *  ever reaching the proxy, so nothing downstream needs the inbound browser's
 *  ambient headers. The host's overlay listener runs the SAME CSRF-equivalent
 *  gate for its own direct callers (`validateOverlayRequest`) and rejects any
 *  request carrying `Origin` on the theory that daemon↔daemon traffic never
 *  sets it — which was true until this proxy forwarded a browser's `Origin`
 *  verbatim and 403'd every routed mutation from the dashboard. Forwarding a
 *  member-local UI's browser-context headers across the hop was never correct
 *  regardless of that gate: the host has no use for them and no cookie is
 *  ever set (bearer-only auth), so `cookie` is stripped alongside `origin` /
 *  `referer` as the same class of header with no business on this hop. */
const STRIPPED_REQUEST_HEADERS = new Set([
  // The destination-host selector must never ride the proxy to the host —
  // it is a member-side routing instruction, not host-facing context.
  'x-myco-host-id',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-connection',
  'authorization',
  REQUEST_CONTEXT_AUTH_HEADER,
  'origin',
  'referer',
  'cookie',
  // The member CLI's transport declaration must not reach the host: the
  // host would render its own binary path into the response. The member
  // daemon's tools layer applies the directive with the member's path.
  'x-myco-tool-transport',
  // TENANCY is the attach mapping's, never the caller's local claim — the same
  // doctrine that overwrites grove/project below. The caller's `x-myco-project-root`
  // names a MEMBER checkout path that does not exist on the host; forwarding it
  // feeds `findRegisteredProject`'s root-equivalence filter, which rejects the
  // host's synthetic-root hosted row (`pathsEquivalent` is false when either path
  // is absent) and 404s the very capture registration-on-ingest just admitted.
  // Dropped here (member-side only; NOT a wire addition) so the host resolves the
  // hosted row by (grove, project) alone. E-4 W2 T1b.
  REQUEST_CONTEXT_HEADERS.projectRoot,
]);

/** Hop-by-hop response headers the relay drops; everything else (including
 *  `content-type: text/event-stream`) is forwarded verbatim so SSE survives. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-connection',
]);

/** A minimal structured logger. The daemon threads its own; a stderr default
 *  keeps the forwarder usable (and loud) without a hard dependency. */
export interface ProxyLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const stderrLogger: ProxyLogger = {
  warn(message, meta) { process.stderr.write(`[myco] host-proxy WARN ${message} ${meta ? JSON.stringify(meta) : ''}\n`); },
  error(message, meta) { process.stderr.write(`[myco] host-proxy ERROR ${message} ${meta ? JSON.stringify(meta) : ''}\n`); },
};

/** Adapt the daemon's category-tagged structured logger (`Logger`/`DaemonLogger`)
 *  to the proxy's category-free {@link ProxyLogger} so both dispatch chokepoints
 *  route proxy logs through one shared adapter under a chosen log category. */
export function proxyLoggerFrom(
  logger: {
    warn(cat: string, msg: string, data?: Record<string, unknown>): void;
    error(cat: string, msg: string, data?: Record<string, unknown>): void;
  },
  category: string,
): ProxyLogger {
  return {
    warn: (message, meta) => logger.warn(category, message, meta),
    error: (message, meta) => logger.error(category, message, meta),
  };
}

/** How the proxy opens the upstream connection to the host. Injectable so a
 *  test can substitute a fixture for the real HTTPS dial. May return a promise
 *  — callers `await` the result, which also accepts a synchronous return. */
export type Dialer = (
  target: RemoteTarget,
  reqOptions: { method: string; path: string; headers: http.OutgoingHttpHeaders },
) => http.ClientRequest | Promise<http.ClientRequest>;

/** Seams the forwarder depends on. Defaults are the real implementations; tests
 *  inject fakes/spies. Passed as an optional final arg so the two chokepoints
 *  (which pass only real deps) need not change signatures. */
export interface HostProxyDeps {
  dial: Dialer;
  /** Flush the member's pending transcript push-queue before forwarding a
   *  session-boundary mining-trigger route. No-op default — the transcript drain
   *  (capture-push C1) plugs in here via `TranscriptDrainQueue.proxyDeps()`. */
  flushBeforeForward: (target: RemoteTarget) => Promise<void>;
  /** Enqueue trigger: called for every COLLECT event the member forwards to a
   *  host, so the transcript drain (C1) keys/updates its work-queue entry and
   *  schedules a mid-turn drain. No-op default; the real impl is the drain queue's
   *  `noteCollect`. Best-effort — must never throw into the collect ack path. */
  noteCollectEvent: (target: RemoteTarget, event: Record<string, unknown>) => void;
  /** Append one collect event to the LOCAL collector buffer via the DB-free
   *  resolver (`resolveProjectBufferDir`, keyed on the attach ref's ids) — never
   *  the hook-style `ensureProjectRegistered` path that would materialize a
   *  local Grove (routing-layer §1.1, §3.1). */
  bufferAppend: (target: RemoteTarget, sessionId: string, event: Record<string, unknown>) => void;
  /** Session-terminal signal (consolidation Task C-2, item 6): fired once,
   *  AFTER the pre-forward flush above, when the route being forwarded is
   *  `/sessions/unregister` (SessionEnd). The member holds no local
   *  session-state for a routed session (it never opens a local Grove DB —
   *  routing-layer §1.1), so this is the ONLY observable completion signal
   *  the member-side drains get. No-op default; the transcript/plan/event-
   *  replay drains plug in here to prune a FULLY-ACKED entry for the ended
   *  session (prune-only-acked — an entry with unshipped bytes is left for
   *  the backstop drain to keep retrying regardless of session end). Async
   *  because the event-replay drain performs one synchronous catch-up drain
   *  of the ended session before deciding whether it can prune (it has no
   *  `flushBeforeForward` of its own — see its class doc). Awaited here, but
   *  still best-effort — must never throw into the collect forward path. */
  noteSessionEnded: (target: RemoteTarget, sessionId: string) => Promise<void>;
  logger: ProxyLogger;
}

/**
 * The authority a host round-trip claims in its `host:` header.
 *
 * Derived from the host's public URL, so it is also the TLS SNI name and what
 * the Funnel edge routes on — get it wrong and the connection does not reach
 * the host at all, rather than reaching it and being refused. The {@link Dialer}
 * seam decides WHERE a request is sent; this decides what it claims to be
 * addressed to, and both now read the same single field.
 *
 * This used to be a CSRF comparand as well: the host compared the Host header
 * against its advertised overlay authority. Funnel rewrites `Host`, so that
 * check could not survive the transport change and was deleted rather than
 * repointed — containment is the team listener's private socket and its token
 * gate now, not a string a caller supplies.
 */
export function hostAuthority(target: RemoteTarget): string {
  return parseHostUrl(target.host.host_url).authority;
}

/**
 * Default dialer: a plain `node:https` request to the host's public URL.
 *
 * One request-construction path, no tunnel, no bridge, no local proxy. The
 * member used to reach a host through a userspace tailscaled's HTTP-CONNECT
 * proxy, which needed a hand-rolled CONNECT handshake and a per-host loopback
 * bridge because Bun's `node:http` client cannot be handed a pre-opened socket.
 * None of that machinery has anything to connect to now: the host is a public
 * HTTPS origin, which every runtime's client can dial directly.
 */
export const defaultDial: Dialer = (target, opts) => {
  const { hostname, port } = parseHostUrl(target.host.host_url);
  // Origin passed as FIELDS, never as a concatenated URL string.
  //
  // `https.request(origin + path)` reparses the result, and a request target is
  // caller-influenced: `'https://host:8443' + '@evil.com/'` reparses to origin
  // `https://evil.com`, and this hop attaches the host bearer. That exact
  // string is unreachable today — llhttp rejects a target starting with `@`,
  // and every other escaping form produces an invalid port against `:8443` —
  // but both defences are accidents of other components, and neither is stated
  // or tested anywhere. Handing `hostname`/`port` separately makes the request
  // structurally incapable of leaving this origin: `path` is only ever a path.
  return https.request({
    protocol: 'https:',
    hostname,
    port,
    method: opts.method,
    path: opts.path,
    headers: opts.headers,
  });
};

function defaultDeps(logger?: ProxyLogger): HostProxyDeps {
  return {
    dial: defaultDial,
    flushBeforeForward: async () => { /* no-op until the transcript drain plugs in */ },
    noteCollectEvent: () => { /* no-op until the transcript drain plugs in */ },
    bufferAppend: (target, sessionId, event) => {
      // Unreachable for host-carrier targets (the carrier admits only
      // team-write routes, never collect) — guarded anyway so a future
      // widening fails loud instead of writing a buffer under 'null'.
      if (target.projectId === null) {
        throw new Error('bufferAppend requires a project-scoped target; host-carrier targets carry none.');
      }
      const bufferDir = resolveProjectBufferDir(target.groveId, target.projectId);
      new EventBuffer(bufferDir, sessionId).append(event);
    },
    noteSessionEnded: async () => { /* no-op until a drain queue plugs in */ },
    logger: logger ?? stderrLogger,
  };
}

/** Whether the member accepts a host speaking `hostProtocol`. Inclusive window
 *  `[HOST_MIN_COMPAT_VERSION, HOST_PROTOCOL_VERSION]`, mirroring the team-sync
 *  compat discipline (routing-layer §5). A skew never self-heals by retry. */
export function hostProtocolCompatible(hostProtocol: number): boolean {
  return hostProtocol >= HOST_MIN_COMPAT_VERSION && hostProtocol <= HOST_PROTOCOL_VERSION;
}

/** Modules that have already logged a version-mismatch for a host, so the loud
 *  log fires once per host rather than per request (routing-layer §5). */
const loggedVersionMismatch = new Set<string>();

export function logVersionMismatchOnce(logger: ProxyLogger, target: RemoteTarget, hostReported?: number): void {
  if (loggedVersionMismatch.has(target.host.host_id)) return;
  loggedVersionMismatch.add(target.host.host_id);
  logger.error('host protocol mismatch — upgrade Myco to reconnect', {
    host_id: target.host.host_id,
    host_label: target.host.label,
    member_protocol: HOST_PROTOCOL_VERSION,
    host_protocol: hostReported ?? target.host.protocol_version,
  });
}

/** Test seam only: reset the once-per-host version-mismatch log de-dup. */
export function __resetVersionMismatchLogForTests(): void {
  loggedVersionMismatch.clear();
}

/**
 * Throttled once-per-key warn for an upstream host failure surfaced to the
 * caller (Task 2, E-4 W2): the general 4xx/5xx relay pass-through and the
 * dedicated host-bearer-rejected (401) branch were both previously silent.
 * Mirrors {@link logVersionMismatchOnce}'s once-per-host posture but keyed
 * finer (host + route class + status class) and bounded by TIME rather than
 * forever — via `shouldLogOncePerInterval` (`daemon/log-throttle.ts`) — so a
 * persistently-refused route resurfaces after the throttle interval instead
 * of going silent for the daemon's whole lifetime. NEVER logs request/
 * response body content (it can carry capture content) — only host_id,
 * path, and the numeric status, the same posture `logVersionMismatchOnce`
 * already holds.
 */
function logRelayFailureOnce(
  logger: ProxyLogger,
  target: RemoteTarget,
  routeClass: RouteStamp,
  status: number,
  pathname: string,
): void {
  const statusClass = `${Math.floor(status / 100)}xx`;
  const key = `relay:${target.host.host_id}:${routeClass}:${statusClass}`;
  if (!shouldLogOncePerInterval(key, REFUSAL_LOG_THROTTLE_INTERVAL_MS)) return;
  logger.warn('host rejected relayed request — response passed through unchanged', {
    host_id: target.host.host_id,
    path: pathname,
    status,
  });
}

/**
 * Throttled warn for a collect-forward failure (host rejection, dial error,
 * or unexpected throw). Capture forwards fire per hook event, so an
 * unthrottled warn per event is a log storm when a host goes unreachable.
 * Same key discipline and interval as
 * {@link logRelayFailureOnce}; body content is never logged.
 */
function logCollectForwardFailureOnce(
  logger: ProxyLogger,
  target: RemoteTarget,
  failureClass: string,
  message: string,
  meta: Record<string, unknown>,
): void {
  const key = `collect-forward:${target.host.host_id}:${failureClass}`;
  if (!shouldLogOncePerInterval(key, REFUSAL_LOG_THROTTLE_INTERVAL_MS)) return;
  logger.warn(message, { host_id: target.host.host_id, ...meta });
}

function safePathname(url: string | undefined): string {
  try { return new URL(url ?? '/', 'http://127.0.0.1').pathname; }
  catch { return '/'; }
}

function methodHasBody(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

/** Read a bounded copy of the request body. Used only where the proxy MUST
 *  inspect bytes (collect append, `/mcp` tool-name peek); serve routes pipe the
 *  live stream and never call this. */
function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > HOST_PROXY_MAX_BUFFERED_BODY_BYTES) {
        reject(new Error('request_body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the upstream request headers: preserve every tenancy `x-myco-*` header
 *  verbatim, drop the local bearer + hop-by-hop + browser-context headers,
 *  attach the HOST bearer and the member's protocol-version header, and point
 *  `host` at the overlay. This hop is always server-to-server — the member
 *  has already run its own browser-facing auth/origin policy on the inbound
 *  request before it ever reaches the proxy — so the upstream leg carries
 *  none of the calling browser's ambient headers. */
function buildForwardHeaders(
  req: http.IncomingMessage,
  target: RemoteTarget,
  hostHeader: string,
  bufferedLength: number | null,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  headers.host = hostHeader;
  headers.authorization = `Bearer ${target.bearer}`;
  headers[HOST_PROTOCOL_HEADER] = String(HOST_PROTOCOL_VERSION);
  // TENANCY is the attach mapping's, never the caller's local claim. A hook or
  // MCP client resolves its grove/project headers from the checkout's LOCAL
  // registration (`.myco/` binding), which on a member names a grove that does
  // not exist on the host — the host would 404 the unknown tenancy (live-caught
  // by the D smoke: `x-myco-grove-id` arrived as the member's prod grove). The
  // capture drains (C1/C5/C7) already stamp their tenancy from the attach
  // target; this is the same rule at the live-relay chokepoint. IDENTITY
  // (machine/session headers) stays the caller's — that is the member's own.
  headers[REQUEST_CONTEXT_HEADERS.groveId] = target.groveId;
  // A host-carrier target has NO project (E1 §5.3 rev 6): the host already
  // supports grove-scoped project-less tenancy (request-context.ts), and a
  // fabricated id would throw UnknownRequestContextError before the handler
  // runs. Omit the header entirely rather than stamping a lie.
  if (target.projectId !== null) {
    headers[REQUEST_CONTEXT_HEADERS.projectId] = target.projectId;
  }
  // MACHINE IDENTITY always crosses the hop. Agent/MCP clients supply
  // `x-myco-machine-id` themselves — forwarded verbatim, never overwritten.
  // A browser supplies none, and a host handler receiving no machine id
  // attributes the write to the daemon executing it — the HOST — which is
  // the wrong holder for claim-style ownership rows. The caller at this hop
  // is the member daemon, so absent a caller-supplied id the member's own
  // is stamped (the same fallback rule as the collect-path event-id stamp,
  // `resolveMemberMachineId`).
  headers[REQUEST_CONTEXT_HEADERS.machineId] = resolveMemberMachineId(req);
  if (bufferedLength !== null) headers['content-length'] = String(bufferedLength);
  return headers;
}

function filterResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

// --- structured member-side error responses (routing-layer §2.4, §3.2, §5.3) ---

function respondRouterJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function respondMcpJson(res: http.ServerResponse, body: string): void {
  if (res.headersSent) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

function hostUnreachablePayload(target: RemoteTarget): Record<string, unknown> {
  return {
    error: 'host_unreachable',
    host_id: target.host.host_id,
    message: `This project is served by host ${target.host.label}, which is currently unreachable over the overlay.`,
    retryable: true,
  };
}

function respondHostUnreachable(res: http.ServerResponse, target: RemoteTarget, isMcp: boolean, mcpId: JsonRpcId = null): void {
  if (isMcp) {
    respondMcpJson(res, mcpSoftFail('host_unreachable', hostUnreachablePayload(target).message as string, target, mcpId));
    return;
  }
  respondRouterJson(res, 503, hostUnreachablePayload(target));
}

function respondHostAuthRejected(res: http.ServerResponse, target: RemoteTarget, isMcp: boolean, mcpId: JsonRpcId = null): void {
  const message = `Host ${target.host.label} rejected this machine's credentials. Re-join the host to refresh the bearer.`;
  if (isMcp) { respondMcpJson(res, mcpSoftFail('host_auth_rejected', message, target, mcpId)); return; }
  respondRouterJson(res, 502, { error: 'host_auth_rejected', host_id: target.host.host_id, message, retryable: false });
}

function respondVersionMismatch(res: http.ServerResponse, target: RemoteTarget, isMcp: boolean, hostReported?: number, mcpId: JsonRpcId = null): void {
  const host = hostReported ?? target.host.protocol_version;
  const message =
    `Host ${target.host.label} requires Team-Host protocol v${host}; this machine speaks `
    + `v${HOST_PROTOCOL_VERSION}. Upgrade Myco to reconnect.`;
  if (isMcp) { respondMcpJson(res, mcpSoftFail('host_protocol_mismatch', message, target, mcpId)); return; }
  respondRouterJson(res, 409, {
    error: 'host_protocol_mismatch',
    host_id: target.host.host_id,
    host_protocol: host,
    member_protocol: HOST_PROTOCOL_VERSION,
    message,
    retryable: false,
  });
}

/** A JSON-RPC request id as the refusal writers carry it: the request's own
 *  id when it was parseable, else null (spec-correct for a response to an
 *  unparseable request). */
type JsonRpcId = string | number | null;

/**
 * Extract the JSON-RPC id from an (already-parsed) `/mcp` request body so a
 * member-side refusal can ECHO it. This is load-bearing for the envelope's
 * schema validity, not a nicety: the MCP SDK's `JSONRPCMessageSchema` accepts
 * a response id that is a string, a number, or ABSENT — but `id: null` fails
 * validation, so a refusal written with `id: null` for a parseable request
 * threw a ZodError inside the SDK client before any McpError classification
 * (a ~3.4KB validation dump instead of the designed friendly message), and
 * made the stdio bridge treat the refusal as a transport failure (two wasted
 * self-heal reconnect attempts). `id: null` remains only for the genuinely
 * unparseable-request case, where the JSON-RPC spec itself prescribes it.
 *
 * A batch (array) takes the first element carrying a valid id — the SDK sends
 * one message per tool-call POST, so this is a conservative edge case, same
 * stance as `isCanopyMcpCall`'s batch handling.
 */
export function mcpRequestIdFromBody(parsed: unknown): JsonRpcId {
  const idOf = (msg: unknown): JsonRpcId => {
    if (!msg || typeof msg !== 'object') return null;
    const id = (msg as Record<string, unknown>).id;
    if (typeof id === 'number') return id;
    if (typeof id === 'string' && id !== '') return id;
    return null;
  };
  if (Array.isArray(parsed)) {
    for (const msg of parsed) {
      const id = idOf(msg);
      if (id !== null) return id;
    }
    return null;
  }
  return idOf(parsed);
}

/** Wrap a member-side soft-fail in the JSON-RPC `-32004` envelope the `/mcp`
 *  layer already uses (the `legacy_vault`/refusal precedent) so MCP clients
 *  render a friendly message instead of `tool_call_failed`. `id` must echo
 *  the request's id whenever the request was parseable — see
 *  {@link mcpRequestIdFromBody} for why (SDK schema validity). `id: null`
 *  remains only for the unparseable-request case, which is what JSON-RPC
 *  itself prescribes there — and no SDK client ever hits it, because the SDK
 *  only sends parseable requests. */
function mcpSoftFail(code: string, message: string, target: RemoteTarget, id: JsonRpcId): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32004, message, data: { code, host_id: target.host.host_id } },
    id,
  });
}

/**
 * Peek a `/mcp` JSON-RPC POST body for a Canopy tool call — the ONE sanctioned
 * exception to `/mcp` opacity (scope-map §6.1).
 *
 * The peek covers the operation's IDENTITY only: the tool name plus the fixed
 * enum operation discriminators (`op`, `type`) that select WHICH operation runs.
 * It never reads operation DATA (query text, ids, paths, content). Canopy has no
 * distinct MCP tool — its capability identity lives at the op level for
 * `myco_cortex`/`myco_search` — so the discriminator is part of the operation's
 * name in all but syntax.
 *
 * Canopy iff `myco_cortex {op: canopy_map|canopy_entry}` or
 * `myco_search {type: canopy}`. Every other `myco_cortex` op (digest,
 * instructions, notifications, …) and every other `myco_search` shape —
 * including a plain search with NO type filter or `type: "all"`, whose valid
 * vault hits must not be refused just because the host holds no Canopy entries —
 * returns false and proxies untouched. A batch (array) refuses if ANY element is
 * a Canopy call (conservative; the SDK sends one message per tool-call POST).
 */
export function isCanopyMcpCall(body: unknown): boolean {
  const isCanopyMessage = (msg: unknown): boolean => {
    if (!msg || typeof msg !== 'object') return false;
    const rec = msg as Record<string, unknown>;
    if (rec.method !== 'tools/call') return false;
    const params = rec.params;
    if (!params || typeof params !== 'object') return false;
    const p = params as Record<string, unknown>;
    const args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>;
    if (p.name === TOOL_CORTEX) return args.op === 'canopy_map' || args.op === 'canopy_entry';
    if (p.name === TOOL_SEARCH) return args.type === 'canopy';
    return false;
  };
  if (Array.isArray(body)) return body.some(isCanopyMessage);
  return isCanopyMessage(body);
}

/**
 * Forward one attached-project request to its host. Replaces the Task 1.2 stub.
 *
 * @param deps injectable seams (dialer, flush hook, buffer append, logger).
 *   Defaults to the real implementations; the daemon threads its own logger.
 */
export async function handleAttachedRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: RemoteTarget,
  classification: RouteClassification,
  deps?: Partial<HostProxyDeps>,
): Promise<void> {
  // Merge only DEFINED overrides so an explicit `{ logger: undefined }` (the
  // /mcp chokepoint when it has no logger) falls back to the default rather than
  // clobbering it with undefined.
  const base = defaultDeps(deps?.logger);
  const d: HostProxyDeps = {
    dial: deps?.dial ?? base.dial,
    flushBeforeForward: deps?.flushBeforeForward ?? base.flushBeforeForward,
    noteCollectEvent: deps?.noteCollectEvent ?? base.noteCollectEvent,
    bufferAppend: deps?.bufferAppend ?? base.bufferAppend,
    noteSessionEnded: deps?.noteSessionEnded ?? base.noteSessionEnded,
    logger: deps?.logger ?? base.logger,
  };
  const pathname = safePathname(req.url);
  const isMcp = pathname === '/mcp';
  const isCollect = classification.stamp === 'collect';

  if (isCollect) {
    await handleCollectRoute(req, res, target, pathname, d);
    return;
  }

  // Non-collect (serve, incl. /mcp): a synchronous proxy. Host-unreachable is a
  // real error surfaced from the dial/relay, never a hang or a local-DB fallback.

  // The one sanctioned `/mcp` envelope peek: read the small JSON-RPC body to
  // degrade Canopy tool calls before they cross the wire, then forward the
  // exact bytes. The RESPONSE still streams unbuffered. Read BEFORE the
  // version pre-check so every member-side refusal writer below (version
  // mismatch included) can echo the request's JSON-RPC id — a refusal that
  // fails to echo it is schema-invalid for SDK clients (see
  // mcpRequestIdFromBody).
  let bufferedBody: Buffer | null = null;
  let mcpId: JsonRpcId = null;
  if (isMcp && methodHasBody(req.method)) {
    try {
      bufferedBody = await readRawBody(req);
    } catch {
      respondRouterJson(res, 413, { error: 'request_body_too_large' });
      return;
    }
    let parsed: unknown;
    try { parsed = bufferedBody.length ? JSON.parse(bufferedBody.toString('utf-8')) : undefined; }
    catch { parsed = undefined; }
    mcpId = mcpRequestIdFromBody(parsed);

    // Version pre-check before any dial: a stored host version outside the
    // member's window never self-heals by retry (routing-layer §5.3).
    if (!hostProtocolCompatible(target.host.protocol_version)) {
      logVersionMismatchOnce(d.logger, target);
      respondVersionMismatch(res, target, isMcp, undefined, mcpId);
      return;
    }
    if (isCanopyMcpCall(parsed)) {
      respondMcpJson(res, refusalMcpBody(hostedCapabilityUnavailable('Code intelligence (Canopy)'), mcpId));
      return;
    }
  } else if (!hostProtocolCompatible(target.host.protocol_version)) {
    // Same pre-check for non-/mcp serve routes (no body peek needed).
    logVersionMismatchOnce(d.logger, target);
    respondVersionMismatch(res, target, isMcp);
    return;
  }

  await forwardAndRelay(req, res, {
    target,
    pathname,
    isMcp,
    mcpId,
    bufferedBody,
    deps: d,
    routeClass: classification.stamp,
  });
}

/**
 * COLLECT routes (routing-layer §3.1): durably append to the local collector
 * buffer FIRST, ack the hook with the member's own `{persisted:false,
 * buffered}` result (never the host's response — opacity holds both directions),
 * then best-effort forward to the host in the background.
 */
async function handleCollectRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: RemoteTarget,
  pathname: string,
  d: HostProxyDeps,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readRawBody(req);
  } catch {
    respondRouterJson(res, 413, { error: 'request_body_too_large' });
    return;
  }

  let event: Record<string, unknown> | undefined;
  try {
    const parsed = body.length ? JSON.parse(body.toString('utf-8')) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) event = parsed as Record<string, unknown>;
  } catch { event = undefined; }

  // Identity-bearing event id (residency §4a): stamp a discrete `/events` body ONCE
  // at collection with `<machine_id>:<uuid>` and persist it, so the live-forward AND
  // the drain-replay of THIS event carry the IDENTICAL id — the host dedups on it
  // (insert-if-not-exists), collapsing at-least-once double-delivery + lost-ack
  // retries to one row while keeping genuinely-distinct repeats distinct. Only
  // `/events` (prompt/tool_use/tool_failure) needs it — the other four collect
  // routes are already idempotent, so they stay byte-opaque (forwarded raw).
  const isEventsRoute = pathname === '/events';
  if (event && isEventsRoute) {
    event = ensureEventId(event, resolveMemberMachineId(req));
  }

  const sessionId = resolveSessionId(event, req);
  let buffered = false;
  if (event && sessionId) {
    try {
      // Stamp the origin route onto the buffered copy so the attach-aware replay
      // drain (capture-push C5) re-forwards each body to the SAME host route it
      // was captured on — the collector buffer holds bodies from all five collect
      // routes and only `/events` bodies carry a `type` (`collect-buffer-route.ts`).
      // A `/events` record also carries the event id stamped above; the drain
      // forwards it through unchanged so the replay dedups against the live copy.
      d.bufferAppend(target, sessionId, stampCollectRoute(event, pathname));
      buffered = true;
    } catch (err) {
      d.logger.error('collector buffer append failed', {
        host_id: target.host.host_id,
        session_id: sessionId,
        error: (err as Error).message,
      });
    }
  } else {
    d.logger.error('collect route missing resolvable session_id', {
      host_id: target.host.host_id,
      path: pathname,
    });
  }

  // Enqueue trigger for the transcript-content drain (capture-push C1): a collect
  // event carrying a transcript_path keys/updates the drain queue and schedules a
  // mid-turn drain of the member-local transcript bytes to the host. Best-effort
  // (the dep never throws); independent of the buffer append above.
  if (event) d.noteCollectEvent(target, event);

  sendCollectAck(res, buffered);

  // Background best-effort forward: version-incompatible or unreachable hosts
  // leave the buffered copy for the attach-aware drain (capture-push Task 5).
  if (!hostProtocolCompatible(target.host.protocol_version)) {
    logVersionMismatchOnce(d.logger, target);
    return;
  }
  // A stamped `/events` body forwards the re-serialized event (with its id) so the
  // live path carries the SAME id the buffer — and therefore the drain-replay —
  // will; other routes forward the original bytes unchanged (byte-opaque).
  const forwardBody = event && isEventsRoute ? Buffer.from(JSON.stringify(event), 'utf-8') : body;
  void forwardCollectInBackground(req, target, pathname, sessionId, forwardBody, buffered, d);
}

/** The member `machine_id` (identity §4a) for stamping a collect event's id — the
 *  same value the hook set as `x-myco-machine-id` and the host attributes the row
 *  to. Falls back to this machine's id when the header is absent. */
function resolveMemberMachineId(req: http.IncomingMessage): string {
  const header = req.headers[REQUEST_CONTEXT_HEADERS.machineId];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.length > 0 ? value : getMachineId();
}

function sendCollectAck(res: http.ServerResponse, buffered: boolean): void {
  if (res.headersSent) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, persisted: false, buffered }));
}

function resolveSessionId(event: Record<string, unknown> | undefined, req: http.IncomingMessage): string | null {
  const fromBody = event?.session_id;
  if (typeof fromBody === 'string' && fromBody) return fromBody;
  const fromHeader = req.headers[REQUEST_CONTEXT_HEADERS.sessionId];
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader;
  return null;
}

/** Forward a collect event to the host after flushing transcript deltas for the
 *  session-boundary routes. The host runs its own stateful capture handler; we
 *  discard its response and log failures with the acknowledgment's durability
 *  outcome. */
async function forwardCollectInBackground(
  req: http.IncomingMessage,
  target: RemoteTarget,
  pathname: string,
  sessionId: string | null,
  body: Buffer,
  buffered: boolean,
  d: HostProxyDeps,
): Promise<void> {
  const durabilityOutcome = buffered
    ? 'buffered copy retained for drain'
    : 'hook fallback required';
  try {
    if (FLUSH_BEFORE_FORWARD_ROUTES.has(pathname)) {
      await d.flushBeforeForward(target);
      // Fired only for the SessionEnd route, and only after the flush above has
      // drained everything the member can reach — so a drain queue checking "is
      // this entry caught up?" right now sees the flush's own result, not a
      // stale pre-flush state.
      if (pathname === '/sessions/unregister' && sessionId) {
        await d.noteSessionEnded(target, sessionId);
      }
    }
    const headers = buildForwardHeaders(req, target, hostAuthority(target), body.length);
    const proxyReq = await d.dial(target, { method: req.method ?? 'POST', path: req.url ?? pathname, headers });
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      const timer = setTimeout(() => { proxyReq.destroy(); done(); }, HOST_PROXY_HEADERS_TIMEOUT_MS);
      proxyReq.on('response', (proxyRes) => {
        clearTimeout(timer);
        const status = proxyRes.statusCode ?? 0;
        if (status === 409 && proxyRes.headers[HOST_PROTOCOL_HEADER] !== undefined) {
          logVersionMismatchOnce(d.logger, target, Number(proxyRes.headers[HOST_PROTOCOL_HEADER]) || undefined);
        } else if (status >= 400) {
          logCollectForwardFailureOnce(d.logger, target, `rejected:${Math.floor(status / 100)}xx`,
            `host rejected collect forward — ${durabilityOutcome}`,
            { path: pathname, status });
        }
        proxyRes.resume(); // drain + discard; the member synthesized its own ack
        proxyRes.on('end', done);
        proxyRes.on('error', done);
      });
      proxyReq.on('error', (err) => {
        clearTimeout(timer);
        logCollectForwardFailureOnce(d.logger, target, 'dial-error',
          `collect forward failed — ${durabilityOutcome}`,
          { path: pathname, error: err.message });
        done();
      });
      proxyReq.end(body);
    });
  } catch (err) {
    logCollectForwardFailureOnce(d.logger, target, 'threw',
      `collect forward threw — ${durabilityOutcome}`,
      { path: pathname, error: (err as Error).message });
  }
}

/** Everything {@link forwardAndRelay} needs beyond the live req/res pair. */
interface ForwardAndRelayOpts {
  target: RemoteTarget;
  pathname: string;
  isMcp: boolean;
  mcpId: JsonRpcId;
  /** Pre-read body (the `/mcp` peek), or null to stream the live request. */
  bufferedBody: Buffer | null;
  deps: HostProxyDeps;
  /** The matched route's stamp (`classification.stamp`), used ONLY to key the
   *  throttled relay-failure log (Task 2, E-4 W2) — never a dispatch input. */
  routeClass: RouteStamp;
}

/**
 * The uniform streamed relay for non-collect routes. Dial the host, forward the
 * body (a pre-read buffer for `/mcp`, else the live request stream), then pipe
 * the upstream response through unbuffered — status, headers, and body,
 * preserving `text/event-stream` framing. Client disconnect tears down the
 * upstream leg.
 */
async function forwardAndRelay(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ForwardAndRelayOpts,
): Promise<void> {
  const { target, pathname, isMcp, mcpId, bufferedBody, deps: d, routeClass } = opts;
  const headers = buildForwardHeaders(req, target, hostAuthority(target), bufferedBody ? bufferedBody.length : null);
  const proxyReq = await d.dial(target, { method: req.method ?? 'GET', path: req.url ?? pathname, headers });

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };

    // Connect bound: destroy the dial if the socket never connects in time.
    proxyReq.on('socket', (socket) => {
      if (!('connecting' in socket) || (socket as Socket).connecting) {
        const connectTimer = setTimeout(() => {
          proxyReq.destroy(new Error('connect_timeout'));
        }, HOST_PROXY_CONNECT_TIMEOUT_MS);
        socket.once('connect', () => clearTimeout(connectTimer));
        socket.once('close', () => clearTimeout(connectTimer));
      }
    });

    // Headers bound: destroy if no response headers arrive in time.
    const headersTimer = setTimeout(() => {
      proxyReq.destroy(new Error('headers_timeout'));
    }, HOST_PROXY_HEADERS_TIMEOUT_MS);

    // Client hung up BEFORE the response finished → tear down the upstream leg
    // (mirrors mcp/http.ts res.on('close')). Guard on `writableEnded` so a
    // normal completion's 'close' doesn't destroy an already-finished relay.
    res.on('close', () => { if (!res.writableEnded) proxyReq.destroy(); });

    proxyReq.on('response', (proxyRes) => {
      clearTimeout(headersTimer);

      // Version mismatch surfaced at runtime: log loudly once per host, then
      // pass the host's 409 through to the caller (routing-layer §5.3).
      const isVersionMismatch409 = proxyRes.statusCode === 409 && proxyRes.headers[HOST_PROTOCOL_HEADER] !== undefined;
      if (isVersionMismatch409) {
        logVersionMismatchOnce(d.logger, target, Number(proxyRes.headers[HOST_PROTOCOL_HEADER]) || undefined);
      }
      // Host rejected the bearer: a member-actionable "re-join the host" error,
      // not a verbatim relay (the caller must not learn the host bearer shape).
      // Still logged (throttled) — an upstream failure the operator needs
      // visibility into even though the body itself is never relayed
      // (Task 2, E-4 W2).
      if (proxyRes.statusCode === 401) {
        proxyRes.resume();
        logRelayFailureOnce(d.logger, target, routeClass, 401, pathname);
        respondHostAuthRejected(res, target, isMcp, mcpId);
        finish();
        return;
      }

      if (res.headersSent) { proxyRes.resume(); finish(); return; }
      const upstreamStatus = proxyRes.statusCode ?? 502;
      // Every OTHER upstream failure is relayed byte-for-byte to the caller
      // (never synthesized) — log it once per throttle window so a
      // persistently-refused route is diagnosable without turning a
      // member's retry loop into a log storm (Task 2, E-4 W2). The 409
      // protocol-mismatch case is already logged above via
      // logVersionMismatchOnce; never double-log it here.
      if (upstreamStatus >= 400 && !isVersionMismatch409) {
        logRelayFailureOnce(d.logger, target, routeClass, upstreamStatus, pathname);
      }
      res.writeHead(upstreamStatus, filterResponseHeaders(proxyRes.headers));

      // Body/idle bound. `/mcp` may stream a long tool result, so it gets an
      // idle-read timeout (reset on each chunk) rather than a fixed body cap.
      let bodyTimer: NodeJS.Timeout | undefined;
      const armIdle = () => {
        if (bodyTimer) clearTimeout(bodyTimer);
        bodyTimer = setTimeout(() => { proxyReq.destroy(); res.destroy(); }, HOST_PROXY_MCP_IDLE_TIMEOUT_MS);
      };
      if (isMcp) {
        armIdle();
        proxyRes.on('data', armIdle);
      } else {
        bodyTimer = setTimeout(() => { proxyReq.destroy(); res.destroy(); }, HOST_PROXY_BODY_TIMEOUT_MS);
      }

      proxyRes.pipe(res);
      const endUpstream = () => { if (bodyTimer) clearTimeout(bodyTimer); finish(); };
      proxyRes.on('end', endUpstream);
      // A torn-down upstream (client disconnect → proxyReq.destroy()) surfaces
      // as 'close'/'error' rather than 'end'; clear timers and settle either way.
      proxyRes.on('close', () => { if (bodyTimer) clearTimeout(bodyTimer); res.destroy(); finish(); });
      proxyRes.on('error', () => { if (bodyTimer) clearTimeout(bodyTimer); res.destroy(); finish(); });
    });

    proxyReq.on('error', (err) => {
      clearTimeout(headersTimer);
      // Pre-response failure: overlay unreachable, connect timeout, ECONNREFUSED,
      // or headers timeout. All map to a clean host-unreachable (never a hang,
      // never a local-DB fallback).
      if (!res.headersSent) respondHostUnreachable(res, target, isMcp, mcpId);
      else res.destroy();
      d.logger.warn('host proxy dial failed', {
        host_id: target.host.host_id,
        path: pathname,
        error: err.message,
      });
      finish();
    });

    // Forward the body: a pre-read buffer (/mcp peek) or the live request stream.
    if (bufferedBody !== null) {
      proxyReq.end(bufferedBody);
    } else if (methodHasBody(req.method)) {
      req.pipe(proxyReq);
      req.on('error', () => proxyReq.destroy());
    } else {
      proxyReq.end();
    }
  });
}
