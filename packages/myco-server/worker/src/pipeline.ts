import type { Env } from './env.js';
import { matchRoute, type Route, type Shape } from './routes.js';
import { activateSuccessor, authenticateServerMemberToken, MEMBER_TOKEN_PATTERN, type MemberAuth } from './auth/tokens.js';
import { HSTS_MAX_AGE_SECONDS, MEMBER_TOKEN_BYTE_QUOTA, MIN_COMPAT_MEMBER_PROTOCOL, PROTOCOL_HEADER, RETRY_AFTER_SECONDS, SERVER_PROTOCOL } from './constants.js';
import { sha256Hex } from './hash.js';
import { readBoundedBody, MAX_BODY_BYTES } from './ingest/body.js';
import { QUOTA_REASON } from './ingest/events.js';
import { classify, emit, SchemaMismatchError, UNAVAILABLE, type Classifier } from './telemetry.js';

export interface ServerDeps {
  now: () => number;
  sourceOf: (request: Request) => string | null;
}

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': `max-age=${HSTS_MAX_AGE_SECONDS}`,
};

function stamp(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

/** The server's protocol number, disclosed only to authenticated members. */
function withProtocol(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set(PROTOCOL_HEADER, String(SERVER_PROTOCOL));
  return new Response(res.body, { status: res.status, headers });
}

const RETRY_AFTER = { 'retry-after': String(RETRY_AFTER_SECONDS) };
const unauthorized = () => Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'www-authenticate': 'Bearer realm="myco"' } });
const unavailable = () => Response.json({ error: UNAVAILABLE }, { status: 503, headers: RETRY_AFTER });
type MemberRoute = Extract<Route, { auth: 'member' }>;
/** The refusal shape of a member route, as the route table declares it. */
const shapeOf = (route: MemberRoute): Shape => route.shape;
/** A server-side failure in the route's refusal shape. Only an authenticated member sees it; before authentication every failure answers the same bare error, so the shape discloses nothing about the route table. */
const unavailableFor = (route: MemberRoute): Response => Response.json({ [shapeOf(route)]: false, code: UNAVAILABLE, reason: UNAVAILABLE }, { status: 503, headers: RETRY_AFTER });
const limited = () => Response.json({ error: 'rate limited' }, { status: 429, headers: RETRY_AFTER });
const unsupportedProtocol = () =>
  Response.json({ error: 'protocol_version_unsupported', server_protocol: SERVER_PROTOCOL, min_compat_member_protocol: MIN_COMPAT_MEMBER_PROTOCOL }, { status: 409 });
export const NO_MACHINE_IDENTITY = 'token has no machine identity';
const PROTOCOL_VALUE = /^[0-9]+$/;

/** A terminal refusal of the caller's own request: 200, never retried, in the route's refusal shape, carrying the classifier as its `code` beside the `reason`; telemetry carries the classifier only. */
function refuse(auth: MemberAuth, shape: Shape, reason: string, classifier: Classifier): Response {
  emit({ kind: shape === 'stored' ? 'blob_refused' : 'ingest_refused', projectId: auth.projectId, tokenId: auth.tokenId, reason: classifier });
  return Response.json({ [shape]: false, code: classifier, reason });
}

/** The presented credential, or null unless it has the minted token shape. The scheme name is case-insensitive. */
function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header === null ? null : /^bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  return MEMBER_TOKEN_PATTERN.test(match[1]) ? match[1] : null;
}

/** True when the member's declared protocol is an integer inside the server's inclusive window. */
function protocolSupported(request: Request): boolean {
  const value = request.headers.get(PROTOCOL_HEADER);
  if (value === null || !PROTOCOL_VALUE.test(value)) return false;
  const n = Number(value);
  return n >= MIN_COMPAT_MEMBER_PROTOCOL && n <= SERVER_PROTOCOL;
}

/** True when the token's stored volume plus this request's bytes would exceed the quota; read fresh after a constraint failure. */
async function overQuota(env: Env, tokenId: string, bytes: number): Promise<boolean> {
  const row = await env.MYCO_DB.prepare(`SELECT bytes_written FROM member_tokens WHERE id = ?`).bind(tokenId).first<{ bytes_written: number }>();
  return row !== null && row.bytes_written + bytes > MEMBER_TOKEN_BYTE_QUOTA;
}

/** A handler failure on any member route, classified once for all. On a route charged to the quota, a quota violation — raised by the charge, or reported as a constraint while the token's stored volume plus this request's bytes stands over the quota — is a terminal refusal; any other failure answers 503 in the route's shape and is retried. */
async function failed(env: Env, auth: MemberAuth, route: MemberRoute, err: unknown, bytes: number): Promise<Response> {
  const shape = shapeOf(route);
  const errorClass = classify(err);
  const charged = route.quotaPrecheck !== false;
  if (charged && (errorClass === 'quota' || (errorClass === 'constraint' && (await overQuota(env, auth.tokenId, bytes))))) return refuse(auth, shape, QUOTA_REASON, 'quota');
  emit({ kind: shape === 'stored' ? 'blob_error' : 'ingest_error', projectId: auth.projectId, tokenId: auth.tokenId, error_class: errorClass });
  return unavailableFor(route);
}

/** Order: route → public → source identity → credential shape → authenticate → successor activation (a successor's first authenticated use takes over its predecessor's held bytes and revokes it, once) → token limit → protocol window → route kind → machine identity (a token without one is refused every write, on every member route, in the route's shape) → body (json routes: bounded read and, on a charged route, the quota pre-check; stream routes: content-length required and capped, body left to the handler) → handler. The source bucket is charged only when a request ends without a member identity: that refusal answers 429 once the bucket is exhausted and 401 before. An authenticated member never charges the source bucket and is never refused by source, on matched and unmatched routes alike. After authentication, a failure of the caller's own request answers 200 with a reason and is never retried; a failure on the server's side — a limiter, a handler, or the storage behind it — answers 503 with retry-after and is retried, in the route's own refusal shape once the route is known. Every response after authentication carries the server's protocol number; responses before it do not. */
export function createServer(deps: ServerDeps) {
  async function run(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const matched = matchRoute(request.method, url.pathname);
    const now = deps.now();

    if (matched?.route.auth === 'public') return matched.route.handler(request);

    const source = deps.sourceOf(request);
    if (source === null) {
      emit({ kind: 'no_source_identity', matched: matched !== null });
      return unavailable();
    }
    const anonymous = async () => ((await env.SOURCE_LIMIT.limit({ key: source })).success ? unauthorized() : limited());

    const presented = bearer(request);
    if (!presented) return anonymous();

    let auth: MemberAuth | null;
    try {
      auth = await authenticateServerMemberToken(env.MYCO_DB, await sha256Hex(presented), now);
    } catch (err) {
      if (!(err instanceof SchemaMismatchError)) throw err;
      emit({ kind: 'schema_mismatch', expected: err.expected, found: err.found });
      if (!matched) return unavailable();
      return unavailableFor(matched.route);
    }
    if (!auth) {
      emit({ kind: 'auth_failed', matched: matched !== null, source: (await sha256Hex(source)).slice(0, 16) });
      return anonymous();
    }
    return withProtocol(await member(request, env, auth, matched, now));
  }

  /** Every failure after authentication answers in the route's shape once the route is known, and carries the protocol number; only what `admitted` returns leaves here. */
  async function member(request: Request, env: Env, auth: MemberAuth, matched: ReturnType<typeof matchRoute>, now: number): Promise<Response> {
    try {
      return await admitted(request, env, auth, matched, now);
    } catch (err) {
      emit({ kind: 'request_error', error_class: classify(err), projectId: auth.projectId, tokenId: auth.tokenId });
      return matched && matched.route.auth !== 'public' ? unavailableFor(matched.route) : unavailable();
    }
  }

  async function admitted(request: Request, env: Env, auth: MemberAuth, matched: ReturnType<typeof matchRoute>, now: number): Promise<Response> {
    if (auth.predecessorId !== null && auth.firstUsedAt === null) {
      await activateSuccessor(env.MYCO_DB, { projectId: auth.projectId, tokenId: auth.tokenId, predecessorId: auth.predecessorId }, now);
      emit({ kind: 'successor_activated', projectId: auth.projectId, tokenId: auth.tokenId, predecessorId: auth.predecessorId });
    }
    if (!(await env.TOKEN_LIMIT.limit({ key: auth.tokenId })).success) return limited();
    if (!protocolSupported(request)) {
      emit({ kind: 'protocol_unsupported', projectId: auth.projectId, tokenId: auth.tokenId });
      return unsupportedProtocol();
    }
    if (!matched) return unauthorized();
    const { route, params } = matched;
    if (route.auth === 'public') return route.handler(request);
    if (auth.machineId === null) return refuse(auth, shapeOf(route), NO_MACHINE_IDENTITY, 'no_machine_identity');

    if (route.bodyMode === 'stream') {
      const declared = request.headers.get('content-length');
      if (declared === null || !PROTOCOL_VALUE.test(declared)) return refuse(auth, route.shape, 'content-length required', 'content_length');
      const contentLength = Number(declared);
      if (contentLength > route.maxBodyBytes) return refuse(auth, route.shape, `blob exceeds ${route.maxBodyBytes} bytes`, 'blob_cap');
      try {
        return await route.handler(env, request, { projectId: auth.projectId, machineId: auth.machineId, tokenId: auth.tokenId, now, clock: deps.now, contentLength, params });
      } catch (err) {
        return failed(env, auth, route, err, contentLength);
      }
    }

    let bodyBytes = 0;
    try {
      const body = await readBoundedBody(request, MAX_BODY_BYTES);
      if (!body.ok) return refuse(auth, route.shape, body.reason, 'body_cap');
      bodyBytes = body.bytes;
      if (route.quotaPrecheck !== false && auth.bytesWritten + body.bytes > MEMBER_TOKEN_BYTE_QUOTA) return refuse(auth, route.shape, QUOTA_REASON, 'quota');
      return await route.handler(env, {
        projectId: auth.projectId, machineId: auth.machineId, tokenId: auth.tokenId,
        expiresAt: auth.expiresAt, lineageRoot: auth.lineageRoot, lineageStartedAt: auth.lineageStartedAt,
        body: body.text, bodyBytes: body.bytes, now,
      });
    } catch (err) {
      return failed(env, auth, route, err, bodyBytes);
    }
  }

  async function handleRequest(request: Request, env: Env): Promise<Response> {
    try {
      return stamp(await run(request, env));
    } catch (err) {
      emit({ kind: 'request_error', error_class: classify(err) });
      return stamp(unavailable());
    }
  }

  return { handleRequest };
}
