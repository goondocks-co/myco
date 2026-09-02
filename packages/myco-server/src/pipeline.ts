import type { ErrorClassifier, ServerEnv } from './core/adapters.js';
import { matchRoute, methodsServing, type Route, type Shape } from './routes.js';
import { activateSuccessor, authenticateServerMemberToken, detectLineageReplay, MEMBER_TOKEN_PATTERN, type MemberAuth } from './auth/tokens.js';
import { authenticateGrant, GRANT_KEY_PATTERN, touchGrant } from './auth/grants.js';
import { HSTS_MAX_AGE_SECONDS, LINEAGE_REPLAY_GRACE_MS, MEMBER_TOKEN_BYTE_QUOTA, MIN_COMPAT_MEMBER_PROTOCOL, PROJECT_HEADER, PROTOCOL_HEADER, RETRY_AFTER_SECONDS, SERVER_PROTOCOL } from './constants.js';
import { sha256Hex } from './hash.js';
import { readBoundedBody, MAX_BODY_BYTES } from './ingest/body.js';
import { QUOTA_REASON } from './ingest/events.js';
import { PROJECT_ARCHIVED, resolveProject } from './ingest/projects.js';
import { classify, emit, SchemaMismatchError, UNAVAILABLE, type Classifier } from './telemetry.js';
import { ownerConfig } from './auth/owner/config.js';
import { readCookie, verifySession } from './auth/owner/cookie.js';
import { memberByGithubId } from './auth/identity-link.js';

/**
 * The platform's error recogniser, read defensively.
 *
 * Every use sits on a failure path — including the outermost catch, which exists
 * precisely to handle a world that is already malformed. A last-resort handler
 * that can itself throw converts a handled failure into an unhandled one, so this
 * never assumes the descriptor is present even though `ServerEnv` requires it.
 * A missing descriptor costs only the platform-specific half of the classification;
 * the platform-independent causes are decided without it.
 */
const errorClassifierOf = (env: ServerEnv): ErrorClassifier | undefined => env.platform?.classifyError;

export interface ServerDeps {
  now: () => number;
  sourceOf: (request: Request) => string | null;
  /** Outbound fetch for the OAuth exchange; injected rather than taken from the global so the dance is testable, matching how `now` and `sourceOf` are supplied. */
  fetchImpl: typeof fetch;
}

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': `max-age=${HSTS_MAX_AGE_SECONDS}`,
};

function stamp(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (k === 'cache-control' && res.headers.has('cache-control')) continue;
    headers.set(k, v);
  }
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
/** A member route that also admits an External Agent grant. */
type GrantRoute = Extract<MemberRoute, { bodyMode: 'json' }> & { grant: NonNullable<Extract<MemberRoute, { bodyMode: 'json' }>['grant']> };
const admitsGrant = (route: Route): route is GrantRoute => route.auth === 'member' && route.bodyMode === 'json' && route.grant !== undefined;
/** The refusal shape of a member route, as the route table declares it. */
const shapeOf = (route: MemberRoute): Shape => route.shape;
/** A grant authenticated to its Project. */
interface GrantAuth {
  grantId: string;
  projectId: string;
}
/** A server-side failure in the route's refusal shape. Only an authenticated member sees it; before authentication every failure answers the same bare error, so the shape discloses nothing about the route table. */
const unavailableFor = (route: MemberRoute): Response => refusalResponse(shapeOf(route), UNAVAILABLE, UNAVAILABLE, 'retryable');
/**
 * A refusal in the route's shape. An `answered` route speaks JSON-RPC, so its
 * refusals are error envelopes carrying the classifier as `data.code`: 400 for a
 * terminal one, 503 with retry-after for a retryable one — the statuses an MCP
 * client surfaces to its caller as a request it can or cannot repeat.
 */
function refusalResponse(shape: Shape, code: string, reason: string, outcome: 'terminal' | 'retryable'): Response {
  const retryable = outcome === 'retryable';
  if (shape === 'answered') {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: reason, data: { code } } }, retryable ? { status: 503, headers: RETRY_AFTER } : { status: 400 });
  }
  return Response.json({ [shape]: false, code, reason }, retryable ? { status: 503, headers: RETRY_AFTER } : undefined);
}
const limited = () => Response.json({ error: 'rate limited' }, { status: 429, headers: RETRY_AFTER });
/**
 * 405 for a served path asked with a method it does not serve, naming the
 * methods it does — or null when no route the predicate admits serves the
 * path at all. Answered only to an authenticated principal, and only among
 * the routes that principal could be admitted to, so the route table is
 * disclosed to nobody it is not already open to. An MCP client opens a GET
 * stream on the endpoint it POSTs to and ends it on 405 without complaint.
 */
function wrongMethod(method: string, pathname: string, admitted: (route: Route) => boolean): Response | null {
  const methods = methodsServing(pathname, admitted);
  if (methods.length === 0) return null;
  return Response.json({ error: 'method_not_allowed', method, allow: methods }, { status: 405, headers: { allow: methods.join(', ') } });
}
const forbidden = () => Response.json({ error: 'forbidden' }, { status: 403 });
const refuseOversized = (bound: number) => Response.json({ error: 'bad_request', reason: `body exceeds ${bound} bytes` }, { status: 400 });

/** The request with its body read under the same cap the member path enforces, or null when it exceeds it. A body-less method passes through untouched. */
async function boundedRequest(request: Request, bound: number): Promise<Request | null> {
  if (request.method === 'GET' || request.method === 'HEAD') return request;
  const body = await readBoundedBody(request, bound);
  if (!body.ok) return null;
  return new Request(request.url, { method: request.method, headers: request.headers, body: body.text });
}

/**
 * True when a state-changing owner request came from this origin. `SameSite=Lax` already
 * blocks cross-site POST, but SameSite is evaluated on the registrable domain while the
 * `__Host-` cookie is origin-scoped: on a custom domain any sibling subdomain is same-site
 * and could mint a token with the owner's cookie attached. Safe methods are exempt.
 */
function sameOrigin(request: Request, url: URL): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin';
  return request.headers.get('origin') === url.origin;
}
const unsupportedProtocol = () =>
  Response.json({ error: 'protocol_version_unsupported', server_protocol: SERVER_PROTOCOL, min_compat_member_protocol: MIN_COMPAT_MEMBER_PROTOCOL }, { status: 409 });
export const NO_MACHINE_IDENTITY = 'token has no machine identity';
export const NO_PROJECT = 'project header required';
/** The routes a member's capture writes through — the ones charged to its quota. */
const captureRoute = (route: MemberRoute): boolean => route.quotaPrecheck !== false;
/** What may be presented as a Project id on the wire. Exported so the member can be pinned against it: the member decides a Project id at `myco member join` and the server never sees it until the first capture, so a member that admits more than this prints "joined" and is then refused every request. */
export const PROJECT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The two names the grammar admits but a Project may not carry. */
export const RESERVED_PROJECT_IDS: readonly string[] = ['.', '..'];

/** Whether `value` may be a Project id: in grammar and not reserved. The one predicate both the wire check and the member's own validation answer to. */
export const isProjectId = (value: string): boolean => PROJECT_ID.test(value) && !RESERVED_PROJECT_IDS.includes(value);

/**
 * The Project this request acts on, named by the member in a header.
 *
 * A credential is Deployment-wide, so the Project cannot come from the
 * credential. It is a per-request assertion, admitted on the strength of
 * Deployment-wide Member Access — never on the caller's say-so. The grammar is
 * checked here so nothing downstream sees caller text it did not validate.
 */
function requestedProject(request: Request): string | null {
  const value = request.headers.get(PROJECT_HEADER);
  if (value === null || !isProjectId(value)) return null;
  return value;
}
const PROTOCOL_VALUE = /^[0-9]+$/;

/** A terminal refusal of the caller's own request: 200, never retried, in the route's refusal shape, carrying the classifier as its `code` beside the `reason`; telemetry carries the classifier only. */
function refuse(auth: MemberAuth, shape: Shape, reason: string, classifier: Classifier): Response {
  emit({ kind: shape === 'stored' ? 'blob_refused' : shape === 'answered' ? 'mcp_refused' : 'ingest_refused', memberId: auth.memberId, tokenId: auth.tokenId, reason: classifier });
  return refusalResponse(shape, classifier, reason, 'terminal');
}

/** A terminal refusal of a grant's own request, in the route's shape; telemetry carries the classifier only. */
function refuseGrant(auth: GrantAuth, route: MemberRoute, reason: string, classifier: Classifier): Response {
  emit({ kind: 'mcp_refused', grantId: auth.grantId, reason: classifier });
  return refusalResponse(shapeOf(route), classifier, reason, 'terminal');
}

type Presented = { kind: 'member'; token: string } | { kind: 'grant'; key: string };

/** The presented credential by its shape — a minted member token or an External Agent grant key — or null for anything else. The two shapes are disjoint. The scheme name is case-insensitive. */
function credential(request: Request): Presented | null {
  const header = request.headers.get('authorization');
  const match = header === null ? null : /^bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  if (MEMBER_TOKEN_PATTERN.test(match[1])) return { kind: 'member', token: match[1] };
  if (GRANT_KEY_PATTERN.test(match[1])) return { kind: 'grant', key: match[1] };
  return null;
}

/** True when the member's declared protocol is an integer inside the server's inclusive window. */
function protocolSupported(request: Request): boolean {
  const value = request.headers.get(PROTOCOL_HEADER);
  if (value === null || !PROTOCOL_VALUE.test(value)) return false;
  const n = Number(value);
  return n >= MIN_COMPAT_MEMBER_PROTOCOL && n <= SERVER_PROTOCOL;
}

/** True when the token's stored volume plus this request's bytes would exceed the quota; read fresh after a constraint failure. */
async function overQuota(env: ServerEnv, tokenId: string, bytes: number): Promise<boolean> {
  const row = await env.db.prepare(`SELECT bytes_written FROM member_credentials WHERE id = ?`).bind(tokenId).first<{ bytes_written: number }>();
  return row !== null && row.bytes_written + bytes > MEMBER_TOKEN_BYTE_QUOTA;
}

/** A handler failure on any member route, classified once for all. On a route charged to the quota, a quota violation — raised by the charge, or reported as a constraint while the token's stored volume plus this request's bytes stands over the quota — is a terminal refusal; any other failure — a token revoked between its authentication and a write that requires it live included — answers 503 in the route's shape and is retried; the retry meets the token's new state at authentication. */
async function failed(env: ServerEnv, auth: MemberAuth, route: MemberRoute, err: unknown, bytes: number): Promise<Response> {
  const shape = shapeOf(route);
  const errorClass = classify(err, errorClassifierOf(env));
  if (captureRoute(route) && (errorClass === 'quota' || (errorClass === 'constraint' && (await overQuota(env, auth.tokenId, bytes))))) return refuse(auth, shape, QUOTA_REASON, 'quota');
  emit({ kind: shape === 'stored' ? 'blob_error' : shape === 'refreshed' ? 'refresh_error' : shape === 'answered' ? 'mcp_error' : 'ingest_error', memberId: auth.memberId, tokenId: auth.tokenId, error_class: errorClass });
  return unavailableFor(route);
}

/** Order: route → public → source identity → credential shape → authenticate → successor activation (a successor's first authenticated use takes over its predecessor's held bytes and revokes it, once) → token limit → protocol window → route kind → machine identity (a token without one is refused every write, on every member route, in the route's shape) → project header (a request naming no Project in grammar is refused before its body is read) → body (json routes: bounded read and, on a charged route, the quota pre-check; stream routes: content-length required and capped, body left to the handler) → project resolution (the first write on the path, so it runs after every refusal the caller cannot retry into success; a Deployment at its Project ceiling answers 503 with retry-after rather than a refusal: nothing the caller sends differs next time) → handler. The source bucket is charged only when a request ends without a member identity: that refusal answers 429 once the bucket is exhausted and 401 before. An authenticated member never charges the source bucket and is never refused by source, on matched and unmatched routes alike. After authentication, a failure of the caller's own request answers 200 with a reason and is never retried; a failure on the server's side — a limiter, a handler, or the storage behind it — answers 503 with retry-after and is retried, in the route's own refusal shape once the route is known. Every response after authentication carries the server's protocol number; responses before it do not. */
export function createServer(deps: ServerDeps) {
  async function run(request: Request, env: ServerEnv): Promise<Response> {
    const url = new URL(request.url);
    const matched = matchRoute(request.method, url.pathname);
    const now = deps.now();

    if (matched?.route.auth === 'public') return matched.route.handler(request);

    const source = deps.sourceOf(request);
    if (source === null) {
      emit({ kind: 'no_source_identity', matched: matched !== null });
      return unavailable();
    }
    const anonymous = async () => ((await env.sourceLimit.limit({ key: source })).success ? unauthorized() : limited());

    // The human surface sits BELOW source identity so it is metered like any other
    // credential-free traffic: an auth route makes an outbound call to GitHub, and an
    // owner route without a valid cookie is as cheap to send as an anonymous member
    // request. Above this point neither would charge the bucket at all.
    // Enrollment sits with the other credential-free surfaces and is metered like them.
    // It is the one route that reaches storage without an authenticated member, and it
    // mints a credential — so the source bucket is charged BEFORE the key is looked at,
    // and a guesser is answered 429 rather than being allowed to keep guessing at the
    // cost of one conditional update each time.
    if (matched?.route.auth === 'enroll') {
      if (!(await env.sourceLimit.limit({ key: source })).success) return limited();
      const bodyBound = (matched.route as { maxBodyBytes?: number }).maxBodyBytes ?? MAX_BODY_BYTES;
      const bounded = await boundedRequest(request, bodyBound);
      if (bounded === null) return refuseOversized(bodyBound);
      try {
        return await matched.route.handler(env, bounded, now);
      } catch (err) {
        emit({ kind: 'request_error', error_class: classify(err, errorClassifierOf(env)) });
        return unavailable();
      }
    }

    if (matched?.route.auth === 'auth' || matched?.route.auth === 'owner') {
      const config = ownerConfig(env);
      if (config === null) return anonymous();
      if (matched.route.auth === 'auth') {
        if (!(await env.sourceLimit.limit({ key: source })).success) return limited();
        return matched.route.handler(request, { config, fetchImpl: deps.fetchImpl, now, origin: url.origin });
      }
      const presented = readCookie(request.headers.get('cookie'));
      const session = presented === null ? null : await verifySession(config.sessionSecret, presented, now);
      if (session === null) return anonymous();
      if (!sameOrigin(request, url)) return forbidden();
      const bodyBound = (matched.route as { maxBodyBytes?: number }).maxBodyBytes ?? MAX_BODY_BYTES;
      const bounded = await boundedRequest(request, bodyBound);
      if (bounded === null) return refuseOversized(bodyBound);
      try {
        // Membership is decided per request: a session names a GitHub account, and
        // the account is a member only while a live member row is linked to it.
        const member = await memberByGithubId(env.db, session.sub);
        const context = { request: bounded, session, config, params: matched.params, url, now };
        if (matched.route.membership === 'optional') {
          // The two routes that serve an account ahead of membership meter a
          // non-member like credential-free traffic: a valid session is free to mint.
          if (member === null && !(await env.sourceLimit.limit({ key: source })).success) return limited();
          return await matched.route.handler(env, { ...context, member });
        }
        if (member === null) return anonymous();
        return await matched.route.handler(env, { ...context, member });
      } catch (err) {
        emit({ kind: 'request_error', error_class: classify(err, errorClassifierOf(env)) });
        return unavailable();
      }
    }

    const credentialPresented = credential(request);
    if (!credentialPresented) return anonymous();
    if (credentialPresented.kind === 'grant') return grant(request, env, credentialPresented.key, matched, url, now, source, anonymous);
    const presented = credentialPresented.token;

    let auth: MemberAuth | null;
    try {
      auth = await authenticateServerMemberToken(env.db, await sha256Hex(presented), now);
    } catch (err) {
      if (!(err instanceof SchemaMismatchError)) throw err;
      emit({ kind: 'schema_mismatch', expected: err.expected, found: err.found });
      if (!matched) return unavailable();
      return unavailableFor(matched.route);
    }
    if (!auth) {
      const digest = await sha256Hex(presented);
      emit({ kind: 'auth_failed', credential: 'member', matched: matched !== null, source: (await sha256Hex(source)).slice(0, 16) });
      // A superseded credential answers 401 like any other, and the answer is the same
      // to the holder either way. The record is what differs: this names which lineage
      // is still being presented after it moved on, and how long after.
      const replay = await detectLineageReplay(env.db, digest, now);
      if (replay !== null) {
        emit({
          kind: 'lineage_replayed', memberId: replay.memberId, tokenId: replay.tokenId,
          lineageRoot: replay.lineageRoot, successorId: replay.successorId,
          sinceActivationMs: now - replay.activatedAt,
          withinHookRace: now - replay.activatedAt <= LINEAGE_REPLAY_GRACE_MS,
        });
      }
      return anonymous();
    }
    return withProtocol(await member(request, env, auth, matched, url, now));
  }

  /**
   * An External Agent grant: authenticated by its key's digest to the one
   * Project its row names, admitted to the one route that declares a grant
   * handler, and refused everywhere else exactly as an authenticated member on
   * a path it cannot reach. None of the member concepts apply — no protocol
   * window, no machine identity, no Project header, no protocol disclosure on
   * the response. Every failure after authentication answers in the route's
   * shape once a grant route is known, as the member path does.
   */
  async function grant(
    request: Request, env: ServerEnv, key: string, matched: ReturnType<typeof matchRoute>, url: URL, now: number, source: string,
    anonymous: () => Promise<Response>,
  ): Promise<Response> {
    let auth: GrantAuth | null;
    try {
      auth = await authenticateGrant(env.db, await sha256Hex(key));
    } catch (err) {
      if (!(err instanceof SchemaMismatchError)) throw err;
      emit({ kind: 'schema_mismatch', expected: err.expected, found: err.found });
      return matched && admitsGrant(matched.route) ? unavailableFor(matched.route) : unavailable();
    }
    if (!auth) {
      emit({ kind: 'auth_failed', credential: 'grant', matched: matched !== null, source: (await sha256Hex(source)).slice(0, 16) });
      return anonymous();
    }
    try {
      return await admittedGrant(request, env, auth, matched, url, now);
    } catch (err) {
      emit({ kind: 'request_error', error_class: classify(err, errorClassifierOf(env)), grantId: auth.grantId });
      return matched && admitsGrant(matched.route) ? unavailableFor(matched.route) : unavailable();
    }
  }

  /** Order: grant limit → route (a served path asked with the wrong method is told so; anything else a grant cannot reach answers 401) → body → use recorded → handler. The Project is the row's; the request names none. */
  async function admittedGrant(request: Request, env: ServerEnv, auth: GrantAuth, matched: ReturnType<typeof matchRoute>, url: URL, now: number): Promise<Response> {
    if (!(await env.tokenLimit.limit({ key: auth.grantId })).success) return limited();
    if (!matched) return wrongMethod(request.method, url.pathname, admitsGrant) ?? unauthorized();
    const { route } = matched;
    if (!admitsGrant(route)) return unauthorized();
    try {
      const body = await readBoundedBody(request, MAX_BODY_BYTES);
      if (!body.ok) return refuseGrant(auth, route, body.reason, 'body_cap');
      await touchGrant(env.db, auth.grantId, now);
      return await route.grant(env, { projectId: auth.projectId, grantId: auth.grantId, body: body.text, now });
    } catch (err) {
      emit({ kind: 'mcp_error', grantId: auth.grantId, error_class: classify(err, errorClassifierOf(env)) });
      return unavailableFor(route);
    }
  }

  /** Every failure after authentication answers in the route's shape once the route is known, and carries the protocol number; only what `admitted` returns leaves here. */
  async function member(request: Request, env: ServerEnv, auth: MemberAuth, matched: ReturnType<typeof matchRoute>, url: URL, now: number): Promise<Response> {
    try {
      return await admitted(request, env, auth, matched, url, now);
    } catch (err) {
      emit({ kind: 'request_error', error_class: classify(err, errorClassifierOf(env)), memberId: auth.memberId, tokenId: auth.tokenId });
      return matched && matched.route.auth === 'member' ? unavailableFor(matched.route) : unavailable();
    }
  }

  async function admitted(request: Request, env: ServerEnv, auth: MemberAuth, matched: ReturnType<typeof matchRoute>, url: URL, now: number): Promise<Response> {
    if (auth.predecessorId !== null && auth.firstUsedAt === null) {
      await activateSuccessor(env.db, { tokenId: auth.tokenId, predecessorId: auth.predecessorId }, now);
      emit({ kind: 'successor_activated', memberId: auth.memberId, tokenId: auth.tokenId, predecessorId: auth.predecessorId });
    }
    if (!(await env.tokenLimit.limit({ key: auth.tokenId })).success) return limited();
    if (!protocolSupported(request)) {
      emit({ kind: 'protocol_unsupported', memberId: auth.memberId, tokenId: auth.tokenId });
      return unsupportedProtocol();
    }
    if (!matched) return wrongMethod(request.method, url.pathname, (r) => r.auth === 'member') ?? unauthorized();
    const { route, params } = matched;
    if (route.auth === 'public') return route.handler(request);
    if (route.auth !== 'member') return unauthorized();
    if (auth.machineId === null) return refuse(auth, shapeOf(route), NO_MACHINE_IDENTITY, 'no_machine_identity');

    // The Project is resolved once, ahead of both body modes, so a request that
    // names none is refused before anything reads its body.
    const projectId = requestedProject(request);
    if (projectId === null) return refuse(auth, shapeOf(route), NO_PROJECT, 'no_project');

    /**
     * Member Access spans the Deployment, so a Project the server has not seen is
     * resolved into existence rather than refused. The bound is the Deployment's, not
     * this member's: a credential naming fresh Projects fills a table its byte quota
     * does not cover.
     *
     * This runs last among the checks, immediately before the handler. It is the first
     * thing on this path that can WRITE, and every refusal above it is one the caller
     * can never retry into success — running it earlier lets a storage fault during
     * resolution answer a terminal refusal as a retryable 503, and spends a Project
     * seat on a request that is never going to be admitted.
     */
    const resolved = async (): Promise<Response | null> => {
      const resolution = await resolveProject(env.db, projectId, now);
      if (resolution.resolved) {
        if (captureRoute(route) && resolution.archived) return refuse(auth, shapeOf(route), PROJECT_ARCHIVED, 'project_archived');
        return null;
      }
      emit({ kind: 'project_limit_reached', memberId: auth.memberId, tokenId: auth.tokenId });
      // 503 with retry-after, NOT a terminal refusal. The ceiling is the Deployment's
      // and only an operator can clear it — nothing the member sends differs next time,
      // which is the definition of the retryable side of this route's contract. A
      // terminal answer here is read by the member as its own request being wrong: the
      // spool drops the event for good, and a refusal carrying no `refreshAfter` marks
      // the credential's rotation terminal, so the machine never rotates again either.
      return unavailableFor(route);
    };

    if (route.bodyMode === 'stream') {
      const declared = request.headers.get('content-length');
      if (declared === null || !PROTOCOL_VALUE.test(declared)) return refuse(auth, shapeOf(route), 'content-length required', 'content_length');
      const contentLength = Number(declared);
      if (contentLength > route.maxBodyBytes) return refuse(auth, shapeOf(route), `blob exceeds ${route.maxBodyBytes} bytes`, 'blob_cap');
      try {
        const limit = await resolved();
        if (limit !== null) return limit;
        return await route.handler(env, request, { projectId, machineId: auth.machineId, tokenId: auth.tokenId, now, clock: deps.now, contentLength, params });
      } catch (err) {
        return failed(env, auth, route, err, contentLength);
      }
    }

    let bodyBytes = 0;
    try {
      const body = await readBoundedBody(request, MAX_BODY_BYTES);
      if (!body.ok) return refuse(auth, shapeOf(route), body.reason, 'body_cap');
      bodyBytes = body.bytes;
      if (captureRoute(route) && auth.bytesWritten + body.bytes > MEMBER_TOKEN_BYTE_QUOTA) return refuse(auth, shapeOf(route), QUOTA_REASON, 'quota');
      const limit = await resolved();
      if (limit !== null) return limit;
      return await route.handler(env, {
        projectId, memberId: auth.memberId, machineId: auth.machineId, tokenId: auth.tokenId,
        expiresAt: auth.expiresAt, lineageRoot: auth.lineageRoot, lineageStartedAt: auth.lineageStartedAt, runtime: auth.runtime,
        body: body.text, bodyBytes: body.bytes, now, origin: url.origin,
      });
    } catch (err) {
      return failed(env, auth, route, err, bodyBytes);
    }
  }

  async function handleRequest(request: Request, env: ServerEnv): Promise<Response> {
    try {
      return stamp(await run(request, env));
    } catch (err) {
      emit({ kind: 'request_error', error_class: classify(err, errorClassifierOf(env)) });
      return stamp(unavailable());
    }
  }

  return { handleRequest };
}
