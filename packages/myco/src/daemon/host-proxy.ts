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
 *      synthesize the member's OWN `{ok,persisted:false,buffered:true}` ack
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
} from '../constants.js';
import { EventBuffer } from '../capture/buffer.js';
import { stampCollectRoute } from '../capture/collect-buffer-route.js';
import { ensureEventId } from '../capture/event-id.js';
import { getMachineId } from '../machine-id.js';
import { resolveProjectBufferDir } from '../grove/paths.js';
import { REQUEST_CONTEXT_AUTH_HEADER, REQUEST_CONTEXT_HEADERS } from '../grove/request-context.js';
import { TOOL_CORTEX, TOOL_SEARCH } from '../tools/definitions.js';
import {
  hostedCapabilityUnavailable,
  refusalMcpBody,
  type RemoteTarget,
  type RouteClassification,
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
 *  the LOCAL bearer never leaks to the host; the HOST bearer is attached fresh. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-connection',
  'authorization',
  REQUEST_CONTEXT_AUTH_HEADER,
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

/** How the proxy opens the upstream connection to the host. Injectable so tests
 *  can dial a localhost fixture and so the CONNECT-proxy path is swappable. */
export type Dialer = (
  target: RemoteTarget,
  reqOptions: { method: string; path: string; headers: http.OutgoingHttpHeaders },
) => http.ClientRequest;

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
  logger: ProxyLogger;
}

/** Parse an overlay address (`host:port`, or a full `http://host:port` URL) into
 *  its host + port. Plain daemon HTTP rides the overlay; TLS is the overlay's
 *  job (parent design §7), so the scheme is HTTP. */
export function parseOverlayAddress(overlayAddress: string): { host: string; port: number } {
  const raw = overlayAddress.includes('://') ? overlayAddress : `http://${overlayAddress}`;
  const url = new URL(raw);
  const port = url.port ? Number(url.port) : 80;
  return { host: url.hostname, port };
}

/** Tunnel a socket through the local userspace-tailscaled HTTP CONNECT proxy
 *  (`--outbound-http-proxy-listen`, recorded as `HostRecord.proxy_port`). Exported
 *  so the member enrollment client (`host/member-overlay.ts`) dials the host through
 *  the SAME proven primitive — one CONNECT mechanism for routing and enrollment.
 *  MUST be driven from inside an `http.Agent.createConnection` (as {@link defaultDial}
 *  does): a bare `http.request({method:'CONNECT'})` is mishandled by Bun's http path. */
export function connectViaHttpProxy(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  cb: (err: Error | null, socket?: Socket) => void,
): void {
  const authority = `${targetHost}:${targetPort}`;
  const connectReq = http.request({
    host: '127.0.0.1',
    port: proxyPort,
    method: 'CONNECT',
    path: authority,
    headers: { host: authority },
  });
  connectReq.once('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      cb(new Error(`overlay CONNECT proxy (127.0.0.1:${proxyPort}) → ${authority} failed: HTTP ${res.statusCode}`));
      return;
    }
    cb(null, socket);
  });
  connectReq.once('error', (err) => cb(err));
  connectReq.end();
}

/**
 * Default dialer: a direct `node:http` request to `overlay_address` for the
 * kernel-mode member, or — when `HostRecord.proxy_port` is set — a request whose
 * Agent tunnels through the local userspace-tailscaled HTTP CONNECT proxy.
 *
 * Mechanism choice (recorded per the brief): `node:http.request` with a custom
 * `http.Agent.createConnection` that issues an HTTP CONNECT and hands back the
 * tunneled socket. This keeps ONE request-construction path (same headers,
 * body-piping, timeout wiring) for both dial modes — the only difference is
 * where the socket comes from — rather than forking into a manual CONNECT +
 * socket-handoff relay for the proxied case.
 */
export const defaultDial: Dialer = (target, opts) => {
  const { host, port } = parseOverlayAddress(target.host.overlay_address);
  if (target.host.proxy_port) {
    const proxyPort = target.host.proxy_port;
    const agent = new http.Agent();
    // The Agent contract: produce a connected socket for (host, port). We
    // produce a CONNECT-tunneled one. Node's typings don't surface the
    // createConnection override cleanly, hence the cast.
    (agent as unknown as {
      createConnection: (o: { host?: string; port?: number }, cb: (e: Error | null, s?: Socket) => void) => void;
    }).createConnection = (o, cb) => {
      connectViaHttpProxy(proxyPort, o.host ?? host, o.port ?? port, cb);
    };
    return http.request({ host, port, method: opts.method, path: opts.path, headers: opts.headers, agent });
  }
  return http.request({ host, port, method: opts.method, path: opts.path, headers: opts.headers });
};

function defaultDeps(logger?: ProxyLogger): HostProxyDeps {
  return {
    dial: defaultDial,
    flushBeforeForward: async () => { /* no-op until the transcript drain plugs in */ },
    noteCollectEvent: () => { /* no-op until the transcript drain plugs in */ },
    bufferAppend: (target, sessionId, event) => {
      const bufferDir = resolveProjectBufferDir(target.groveId, target.projectId);
      new EventBuffer(bufferDir, sessionId).append(event);
    },
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
 *  verbatim, drop the local bearer + hop-by-hop headers, attach the HOST bearer
 *  and the member's protocol-version header, and point `host` at the overlay. */
function buildForwardHeaders(
  req: http.IncomingMessage,
  target: RemoteTarget,
  overlayHostHeader: string,
  bufferedLength: number | null,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  headers.host = overlayHostHeader;
  headers.authorization = `Bearer ${target.bearer}`;
  headers[HOST_PROTOCOL_HEADER] = String(HOST_PROTOCOL_VERSION);
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

function respondHostUnreachable(res: http.ServerResponse, target: RemoteTarget, isMcp: boolean): void {
  if (isMcp) {
    respondMcpJson(res, mcpSoftFail('host_unreachable', hostUnreachablePayload(target).message as string, target));
    return;
  }
  respondRouterJson(res, 503, hostUnreachablePayload(target));
}

function respondHostAuthRejected(res: http.ServerResponse, target: RemoteTarget, isMcp: boolean): void {
  const message = `Host ${target.host.label} rejected this machine's credentials. Re-join the host to refresh the bearer.`;
  if (isMcp) { respondMcpJson(res, mcpSoftFail('host_auth_rejected', message, target)); return; }
  respondRouterJson(res, 502, { error: 'host_auth_rejected', host_id: target.host.host_id, message, retryable: false });
}

function respondVersionMismatch(res: http.ServerResponse, target: RemoteTarget, isMcp: boolean, hostReported?: number): void {
  const host = hostReported ?? target.host.protocol_version;
  const message =
    `Host ${target.host.label} requires Team-Host protocol v${host}; this machine speaks `
    + `v${HOST_PROTOCOL_VERSION}. Upgrade Myco to reconnect.`;
  if (isMcp) { respondMcpJson(res, mcpSoftFail('host_protocol_mismatch', message, target)); return; }
  respondRouterJson(res, 409, {
    error: 'host_protocol_mismatch',
    host_id: target.host.host_id,
    host_protocol: host,
    member_protocol: HOST_PROTOCOL_VERSION,
    message,
    retryable: false,
  });
}

/** Wrap a member-side soft-fail in the JSON-RPC `-32004` envelope the `/mcp`
 *  layer already uses (the `legacy_vault`/refusal precedent) so MCP clients
 *  render a friendly message instead of `tool_call_failed`. */
function mcpSoftFail(code: string, message: string, target: RemoteTarget): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32004, message, data: { code, host_id: target.host.host_id } },
    id: null,
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

  // Version pre-check before any dial: a stored host version outside the
  // member's window never self-heals by retry (routing-layer §5.3).
  if (!hostProtocolCompatible(target.host.protocol_version)) {
    logVersionMismatchOnce(d.logger, target);
    respondVersionMismatch(res, target, isMcp);
    return;
  }

  let bufferedBody: Buffer | null = null;
  if (isMcp && methodHasBody(req.method)) {
    // The one sanctioned `/mcp` envelope peek: read the small JSON-RPC body to
    // degrade Canopy tool calls before they cross the wire, then forward the
    // exact bytes. The RESPONSE still streams unbuffered.
    try {
      bufferedBody = await readRawBody(req);
    } catch {
      respondRouterJson(res, 413, { error: 'request_body_too_large' });
      return;
    }
    let parsed: unknown;
    try { parsed = bufferedBody.length ? JSON.parse(bufferedBody.toString('utf-8')) : undefined; }
    catch { parsed = undefined; }
    if (isCanopyMcpCall(parsed)) {
      respondMcpJson(res, refusalMcpBody(hostedCapabilityUnavailable('Code intelligence (Canopy)')));
      return;
    }
  }

  await forwardAndRelay(req, res, target, pathname, isMcp, bufferedBody, d);
}

/**
 * COLLECT routes (routing-layer §3.1): durably append to the local collector
 * buffer FIRST, ack the hook with the member's own `{persisted:false,
 * buffered:true}` (never the host's response — opacity holds both directions),
 * then best-effort forward to the host in the background. The ack's truthfulness
 * rests on the local buffer, so the hook never depends on synchronous host
 * reachability and its buffer-fallback never fires — the daemon already holds the
 * durable copy, so a hook-side fallback would only DOUBLE-BUFFER the same event.
 * (Task 1.0 made the hook's `ensureProjectRegistered` attach-aware, so a fallback
 * no longer materializes a local Grove; redundant buffering is the residual harm.)
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
  if (event && sessionId) {
    try {
      // Stamp the origin route onto the buffered copy so the attach-aware replay
      // drain (capture-push C5) re-forwards each body to the SAME host route it
      // was captured on — the collector buffer holds bodies from all five collect
      // routes and only `/events` bodies carry a `type` (`collect-buffer-route.ts`).
      // A `/events` record also carries the event id stamped above; the drain
      // forwards it through unchanged so the replay dedups against the live copy.
      d.bufferAppend(target, sessionId, stampCollectRoute(event, pathname));
    } catch (err) {
      // A failed buffer append must not hard-fail the agent. We still synthesize
      // the buffered ack rather than a fallback-tripping response: tripping the
      // hook fallback would double-buffer the event (the daemon owns the durable
      // copy), the worse outcome.
      d.logger.error('collector buffer append failed', {
        host_id: target.host.host_id,
        session_id: sessionId,
        error: (err as Error).message,
      });
    }
  } else {
    // Contract violation — collect routes always carry a session_id. We cannot
    // key the buffer, so log loudly, but still synthesize the buffered ack to
    // avoid the redundant double-buffer a fallback-tripping response would cause.
    d.logger.error('collect route missing resolvable session_id — buffered ack synthesized without append', {
      host_id: target.host.host_id,
      path: pathname,
    });
  }

  // Enqueue trigger for the transcript-content drain (capture-push C1): a collect
  // event carrying a transcript_path keys/updates the drain queue and schedules a
  // mid-turn drain of the member-local transcript bytes to the host. Best-effort
  // (the dep never throws); independent of the buffer append above.
  if (event) d.noteCollectEvent(target, event);

  // Ack the hook now — it is unblocked and holds no reason to buffer (the daemon
  // owns the durable copy).
  sendCollectAck(res);

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
  void forwardCollectInBackground(req, target, pathname, forwardBody, d);
}

/** The member `machine_id` (identity §4a) for stamping a collect event's id — the
 *  same value the hook set as `x-myco-machine-id` and the host attributes the row
 *  to. Falls back to this machine's id when the header is absent. */
function resolveMemberMachineId(req: http.IncomingMessage): string {
  const header = req.headers[REQUEST_CONTEXT_HEADERS.machineId];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.length > 0 ? value : getMachineId();
}

function sendCollectAck(res: http.ServerResponse): void {
  if (res.headersSent) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, persisted: false, buffered: true }));
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
 *  discard its response (the member already acked). Errors are swallowed — the
 *  buffered copy + drain is the durability guarantee. */
async function forwardCollectInBackground(
  req: http.IncomingMessage,
  target: RemoteTarget,
  pathname: string,
  body: Buffer,
  d: HostProxyDeps,
): Promise<void> {
  try {
    if (FLUSH_BEFORE_FORWARD_ROUTES.has(pathname)) {
      await d.flushBeforeForward(target);
    }
    const { host: overlayHost, port } = parseOverlayAddress(target.host.overlay_address);
    const headers = buildForwardHeaders(req, target, `${overlayHost}:${port}`, body.length);
    const proxyReq = d.dial(target, { method: req.method ?? 'POST', path: req.url ?? pathname, headers });
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
          // The member already acked buffered:true; a host rejection (bad bearer,
          // etc.) is not lost — the buffered copy drains on retry — but a
          // persistent one must be visible.
          d.logger.warn('host rejected collect forward — buffered copy retained for drain', {
            host_id: target.host.host_id, path: pathname, status,
          });
        }
        proxyRes.resume(); // drain + discard; the member synthesized its own ack
        proxyRes.on('end', done);
        proxyRes.on('error', done);
      });
      proxyReq.on('error', (err) => {
        clearTimeout(timer);
        d.logger.warn('collect forward failed — buffered copy retained for drain', {
          host_id: target.host.host_id,
          path: pathname,
          error: err.message,
        });
        done();
      });
      proxyReq.end(body);
    });
  } catch (err) {
    d.logger.warn('collect forward threw — buffered copy retained for drain', {
      host_id: target.host.host_id,
      path: pathname,
      error: (err as Error).message,
    });
  }
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
  target: RemoteTarget,
  pathname: string,
  isMcp: boolean,
  bufferedBody: Buffer | null,
  d: HostProxyDeps,
): Promise<void> {
  const { host: overlayHost, port } = parseOverlayAddress(target.host.overlay_address);
  const headers = buildForwardHeaders(req, target, `${overlayHost}:${port}`, bufferedBody ? bufferedBody.length : null);
  const proxyReq = d.dial(target, { method: req.method ?? 'GET', path: req.url ?? pathname, headers });

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
      if (proxyRes.statusCode === 409 && proxyRes.headers[HOST_PROTOCOL_HEADER] !== undefined) {
        logVersionMismatchOnce(d.logger, target, Number(proxyRes.headers[HOST_PROTOCOL_HEADER]) || undefined);
      }
      // Host rejected the bearer: a member-actionable "re-join the host" error,
      // not a verbatim relay (the caller must not learn the host bearer shape).
      if (proxyRes.statusCode === 401) {
        proxyRes.resume();
        respondHostAuthRejected(res, target, isMcp);
        finish();
        return;
      }

      if (res.headersSent) { proxyRes.resume(); finish(); return; }
      res.writeHead(proxyRes.statusCode ?? 502, filterResponseHeaders(proxyRes.headers));

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
      if (!res.headersSent) respondHostUnreachable(res, target, isMcp);
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
