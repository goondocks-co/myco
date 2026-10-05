import { RETIRED_RUN_ROUTES } from './api/runs.js';
import { authorizeDeclaration, deploymentIdentity, memberSubject, type AuthorizationSubject } from './auth/authorization.js';
import { authorizeHttp, httpAuthorizationDecision } from './auth/http-authorization.js';
import { emptyBodyRefusal, LINK_REQUIRES_ADMIN } from './auth/members.js';
import { parseJsonObject, badRequest } from './api/scope.js';
import { RAW_CACHE_HEADERS } from './core/raw-resources.js';
import { runControlRefusalCode } from '@goondocks/myco-shared/run-control';
import { MACHINE_SETTINGS_FEATURE, MACHINE_SETTINGS_HEADER, MACHINE_SETTINGS_REVISION_HEADER, MACHINE_SETTINGS_ORDER_HEADER, MACHINE_SETTINGS_INVALIDATED_HEADER, isMachineSettingsRevision } from '@goondocks/myco-shared/member-protocol';
import type { ErrorClassifier, OutboundFetch, ServerEnv } from './core/adapters.js';
import { TURN_END_HEADER } from './ingest/turns.js';
import { stampRequest } from './core/activity.js';
import { matchRoute, methodsServing, type Route, type Shape } from './routes.js';
import { activateSuccessor, authenticateServerMemberToken, releasedRunCredential, detectLineageReplay, LINEAGE_REPLAY_REVOKER, MEMBER_LINEAGE_IDLE_MS, LINEAGE_REPLAYED_CODE, MEMBER_TOKEN_PATTERN, revokedForReplay, revokeMemberLineage, type ExpiryAdmission, type MemberAuth } from './auth/tokens.js';
import { admitRunControl, CONTROL_CAPABILITIES, heldRunOfCredential, runDeadline, runtimeCaller } from './api/run-admission.js';
import { runWriteStore, RunWriteExpired } from './core/run-write-store.js';
import { recordRunCall, recordRunControlRefusal, type HeldRun } from './core/runs.js';
import { HARNESS_MEMBER_ID } from './core/harness.js';
import { forbiddenToMember } from './auth/roles.js';
import { authenticateGrant, GRANT_KEY_PATTERN, touchGrant } from './auth/grants.js';
import { FEATURES_HEADER, HSTS_MAX_AGE_SECONDS, LINEAGE_REPLAY_GRACE_MS, MIN_COMPAT_MEMBER_PROTOCOL, PROJECT_HEADER, PROTOCOL_HEADER, RETRY_AFTER_SECONDS, SERVER_FEATURES, SERVER_PROTOCOL } from './constants.js';
import { sha256Hex } from './hash.js';
import { readBoundedBody, MAX_BODY_BYTES } from './ingest/body.js';
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
  fetchImpl: OutboundFetch;
}

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': `max-age=${HSTS_MAX_AGE_SECONDS}`,
};

function stamp(res: Response, raw = false): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (k === 'cache-control' && res.headers.has('cache-control')) continue;
    headers.set(k, v);
  }
  if (raw) for (const [key, value] of Object.entries(RAW_CACHE_HEADERS)) headers.set(key, value);
  return new Response(res.body, { status: res.status, headers });
}

/** The server's protocol number and the features it takes beyond it, disclosed only to authenticated members. */
function withProtocol(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set(PROTOCOL_HEADER, String(SERVER_PROTOCOL));
  headers.set(FEATURES_HEADER, SERVER_FEATURES.join(','));
  return new Response(res.body, { status: res.status, headers });
}

const RETRY_AFTER = { 'retry-after': String(RETRY_AFTER_SECONDS) };
const unauthorized = () => Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'www-authenticate': 'Bearer realm="myco"' } });
/** A 401 to a credential a replay revocation ended, naming why. Like every 401 before authentication it carries no protocol header, so a member reads it as a refusal of its credential. */
const replayRevoked = () => Response.json({ error: 'unauthorized', code: LINEAGE_REPLAYED_CODE }, { status: 401, headers: { 'www-authenticate': 'Bearer realm="myco"' } });
const unavailable = () => Response.json({ error: UNAVAILABLE }, { status: 503, headers: RETRY_AFTER });
type MemberRoute = Extract<Route, { auth: 'member' }>;
/** A json member route that serves the run principal. */
type RunRoute = Extract<MemberRoute, { bodyMode: 'json' }> & { run: NonNullable<Extract<MemberRoute, { bodyMode: 'json' }>['run']> };
const servesRun = (route: MemberRoute): route is RunRoute => route.bodyMode === 'json' && route.run !== undefined;
/** A route scoped to the whole Deployment rather than to one Project. */
type DeploymentRoute = Extract<MemberRoute, { scope: 'deployment' }>;
const deploymentScoped = (route: MemberRoute): route is DeploymentRoute => 'scope' in route && route.scope === 'deployment';
/** A route answered on the presented credential alone, with no Project read or resolved. */
type CredentialRoute = Extract<MemberRoute, { scope: 'credential' }>;
const credentialScoped = (route: MemberRoute): route is CredentialRoute => 'scope' in route && route.scope === 'credential';
/** A member route that also admits an External Agent grant. */
type GrantRoute = Extract<MemberRoute, { bodyMode: 'json' }> & { grant: NonNullable<Extract<MemberRoute, { bodyMode: 'json' }>['grant']> };
const admitsGrant = (route: Route): route is GrantRoute => route.auth === 'member' && route.bodyMode === 'json' && route.grant !== undefined;
/** How a credential past its expiry is treated on the matched route: admitted only where the route table declares `admitsLapsed`, refused everywhere else, an unmatched path included. */
const expiryAdmissionOf = (route: Route | undefined): ExpiryAdmission =>
  route?.auth === 'member' && credentialScoped(route) && route.admitsLapsed === true ? 'lapsed' : 'live';
/** Whether the matched route asks for the presented credential's successor: the one route on which a superseded credential ends its lineage. */
const asksToRotate = (route: Route | undefined): boolean => route?.auth === 'member' && credentialScoped(route) && route.shape === 'refreshed';
/** Whether the matched route answers with an authority that can outlive the presented credential, as the route table declares it. */
const mintsAuthority = (route: MemberRoute): boolean => 'mintsAuthority' in route && route.mintsAuthority === true;
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
/** What a member who does not administer the Deployment is told on a Deployment-scoped route. */
export const NOT_ADMIN = 'this route serves an administrator of the Deployment';
/** What a run's credential is told on a member route that is not its run's surface. */
export const RUN_SCOPE = 'a run credential reaches only its run\'s surface';
/** What a credential its issuer minted not to rotate is told on the refresh route. */
export const NON_ROTATING = 'this credential does not rotate; mint another when it expires';
/** What a credential its issuer minted not to rotate is told on any other route that mints an authority able to outlive it. */
export const NON_ROTATING_AUTHORITY = 'a credential that does not rotate mints no authority that outlives it';
/** What a run's credential is told when no live run names it. */
export const NO_LIVE_RUN = 'credential holds no live run';
/** What a run's credential is told when the Project header names a Project other than the run's. */
export const RUN_PROJECT_MISMATCH = 'project header names a Project other than the run\'s';
/** The routes a member's capture writes through: refused on an archived Project. Never refused for volume (#1416). */
const captureRoute = (route: MemberRoute): boolean => route.capture !== false;
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
/**
 * Record one run route a container drove, against the run its credential holds.
 *
 * Both doors a run calls through record on one rule: a call the Deployment
 * ADMITTED and answered. A refused route answers `persisted: false` and writes
 * nothing at all, which is what keeps a credential from turning calls it may not
 * make into rows — the same rule the MCP door applies to a call off a run's
 * surface.
 *
 * The run is normally the one resolved before the handler ran. A claim is the
 * exception: it is the call that MAKES a run held, so nothing held it beforehand
 * and the run is resolved again once the claim has been answered. A container
 * that claims and then dies is then a run with one call against it rather than a
 * run that reads as never having reached this Deployment at all.
 */
async function recordRunRoute(
  env: ServerEnv,
  auth: MemberAuth,
  path: string,
  answered: Response,
  heldBefore: HeldRun | null,
  now: number,
): Promise<void> {
  let persisted = false;
  try {
    const result = await answered.clone().json() as { persisted?: unknown; applied?: unknown; changed?: unknown; claimed?: unknown };
    persisted = result.persisted === true && result.claimed !== false && !(result.applied === false && result.changed === 0);
  } catch {
    persisted = false;
  }
  if (!persisted) return;
  const held = heldBefore ?? await heldRunOfCredential(env, auth, now);
  if (held === null) return;
  emit({ kind: 'run_tool', runId: held.id, task: held.task, tool: path, op: null, tokenId: auth.tokenId });
  await recordRunCall(env.db, { projectId: held.projectId }, { runId: held.id, toolName: path, op: null, durationMs: null, recordedAt: now });
}

function refuse(auth: MemberAuth, shape: Shape, reason: string, classifier: Classifier, named: Record<string, string> = {}): Response {
  emit({ kind: shape === 'stored' ? 'blob_refused' : shape === 'answered' ? 'mcp_refused' : 'ingest_refused', memberId: auth.memberId, tokenId: auth.tokenId, reason: classifier, ...named });
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

/** A handler failure on any member route, classified once for all: it answers 503 in the route's shape and is retried — a token revoked between its authentication and a write that requires it live included; the retry meets the token's new state at authentication. */
function failed(env: ServerEnv, auth: MemberAuth, route: MemberRoute, err: unknown): Response {
  const shape = shapeOf(route);
  const errorClass = classify(err, errorClassifierOf(env));
  emit({ kind: shape === 'stored' ? 'blob_error' : shape === 'refreshed' ? 'refresh_error' : shape === 'answered' ? 'mcp_error' : 'ingest_error', memberId: auth.memberId, tokenId: auth.tokenId, error_class: errorClass });
  return unavailableFor(route);
}

function machineContractHeaders(request: Request): { machineSettingsFeature?: true; machineSettingsRevision?: string; machineSettingsOrder?: number; machineSettingsInvalidated?: true } {
  if (request.headers.get(MACHINE_SETTINGS_HEADER) !== MACHINE_SETTINGS_FEATURE) return {};
  const revision = request.headers.get(MACHINE_SETTINGS_REVISION_HEADER);
  const order = request.headers.get(MACHINE_SETTINGS_ORDER_HEADER);
  return {
    machineSettingsFeature: true,
    ...(isMachineSettingsRevision(revision) ? { machineSettingsRevision: revision } : {}),
    ...(order !== null && /^[0-9]+$/.test(order) && Number.isSafeInteger(Number(order)) ? { machineSettingsOrder: Number(order) } : {}),
    ...(request.headers.get(MACHINE_SETTINGS_INVALIDATED_HEADER) === '1' ? { machineSettingsInvalidated: true } : {}),
  };
}

/** Order: route → public → source identity → credential shape → authenticate → successor activation (a successor's first authenticated use takes over its predecessor's held bytes and revokes it, once) → token limit → protocol window → route kind → machine identity (a token without one is refused every write, on every member route, in the route's shape) → project header (a request naming no Project in grammar is refused before its body is read) → body (json routes: bounded read; stream routes: content-length required and capped, body left to the handler) → project resolution (the first write on the path, so it runs after every refusal the caller cannot retry into success; a Deployment at its Project ceiling answers 503 with retry-after rather than a refusal: nothing the caller sends differs next time) → handler. The source bucket is charged only when a request ends without a member identity: that refusal answers 429 once the bucket is exhausted and 401 before. An authenticated member never charges the source bucket and is never refused by source, on matched and unmatched routes alike. After authentication, a failure of the caller's own request answers 200 with a reason and is never retried; a failure on the server's side — a limiter, a handler, or the storage behind it — answers 503 with retry-after and is retried, in the route's own refusal shape once the route is known. Every response after authentication carries the server's protocol number; responses before it do not. */
function protocolAdmitted(route: Route, kind: 'public' | 'enrollment'): boolean {
  return authorizeDeclaration({ kind, deploymentId: 'protocol', transport: 'http', live: true }, route.authorization, {}, { kind: 'protocol', deploymentId: 'protocol', exists: true });
}

async function runSubject(env: ServerEnv, run: HeldRun, tokenId: string): Promise<AuthorizationSubject> {
  return { kind: 'run', deploymentId: await deploymentIdentity(env.db), transport: 'http', live: true, projectId: run.projectId, runId: run.id, tokenId, attempt: run.resumedAt ?? run.startedAt ?? 0 };
}

export function createServer(deps: ServerDeps) {
  async function run(request: Request, env: ServerEnv): Promise<Response> {
    const url = new URL(request.url);
    const matched = matchRoute(request.method, url.pathname);
    const now = deps.now();

    if (matched?.route.auth === 'public') return protocolAdmitted(matched.route, 'public') ? matched.route.handler(request) : unauthorized();

    const source = deps.sourceOf(request);
    if (source === null) {
      emit({ kind: 'no_source_identity', matched: matched !== null });
      return unavailable();
    }
    const anonymous = async () => ((await env.sourceLimit.limit({ key: source })).success ? unauthorized() : limited());

    // The human surface sits BELOW source identity so it is metered like any other
    // credential-free traffic: an auth route makes an outbound call to GitHub, and a
    // session route without a valid cookie is as cheap to send as an anonymous member
    // request. Above this point neither would charge the bucket at all.
    // Enrollment sits with the other credential-free surfaces and is metered like them.
    // It is the one route that reaches storage without an authenticated member, and it
    // mints a credential — so the source bucket is charged BEFORE the key is looked at,
    // and a guesser is answered 429 rather than being allowed to keep guessing at the
    // cost of one conditional update each time.
    if (matched?.route.auth === 'enroll') {
      if (!(await env.sourceLimit.limit({ key: source })).success) return limited();
      if (!protocolAdmitted(matched.route, 'enrollment')) return unauthorized();
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

    if (matched?.route.auth === 'auth' || matched?.route.auth === 'session') {
      const config = ownerConfig(env);
      if (config === null) return anonymous();
      if (matched.route.auth === 'auth') {
        if (!(await env.sourceLimit.limit({ key: source })).success) return limited();
        if (!protocolAdmitted(matched.route, 'public')) return unauthorized();
        return matched.route.handler(request, { config, fetchImpl: deps.fetchImpl, now, origin: url.origin });
      }
      const presented = readCookie(request.headers.get('cookie'));
      const session = presented === null ? null : await verifySession(config.sessionSecret, presented, now);
      if (session === null) return anonymous();
      if (!sameOrigin(request, url)) return forbidden();
      try {
        // Membership is decided per request: a session names a GitHub account, and
        // the account is a member only while a live member row is linked to it.
        const member = await memberByGithubId(env.db, session.sub);
        if (matched.route.authority === 'account') {
          // The routes that serve an account ahead of membership meter a non-member
          // like credential-free traffic: a valid session is free to mint.
          if (member === null && !(await env.sourceLimit.limit({ key: source })).success) return limited();
        } else {
          if (member === null) return anonymous();
          if (matched.route.authorization === undefined) return forbiddenToMember();
        }
        const bodyBound = (matched.route as { maxBodyBytes?: number }).maxBodyBytes ?? MAX_BODY_BYTES;
        const bounded = await boundedRequest(request, bodyBound);
        if (bounded === null) return refuseOversized(bodyBound);
        const context = { request: bounded, session, config, params: matched.params, url, now };
        const subject: AuthorizationSubject = member === null ? { kind: 'account', deploymentId: await deploymentIdentity(env.db), transport: 'http', live: true } : await memberSubject(env.db, member.id, 'http');
        const body = await bounded.clone().text();
        const authorization = await httpAuthorizationDecision(env, matched.route.authorization, subject, { params: matched.params, body, rawKind: 'raw' in matched.route ? matched.route.raw?.resource : undefined });
        if (!authorization.allowed) {
          if (matched.route.authority === 'admin' && subject.role === 'member') return forbiddenToMember();
          if (matched.route.path === '/api/enrollment' && authorization.action === null) return badRequest('role must be admin or member');
          if (authorization.resource?.kind === 'enrollment' && authorization.resource.targetRevoked === true) return Response.json({ error: 'member_revoked' }, { status: 409 });
          if (matched.route.path === '/api/harness/dispatch') {
            if (authorization.action === 'admin' && subject.role === 'member') return Response.json({ error: 'fresh_needs_admin' }, { status: 403 });
            return badRequest('the project is not on this server');
          }
          if (authorization.resource?.exists === false && (matched.route.authorization?.resource !== 'credential' || matched.route.authorization.resolver === 'machine')) return Response.json({ error: 'not_found' }, { status: 404 });
          if (matched.route.path.endsWith('/connect')) return Response.json({ error: 'not_found' }, { status: 404 });
          if (matched.route.authorization?.resource === 'machine-settings') return Response.json({ applied: false, reason: 'forbidden', detail: 'only the member this machine belongs to reaches its settings' }, { status: 403 });
          if (matched.route.authorization?.resource === 'credential' && matched.route.authorization.resolver === 'machine') return Response.json({ error: 'not_found' }, { status: 404 });
          if (matched.route.authorization?.resource === 'credential' && matched.route.authorization.action === 'edit') return Response.json({ revoked: matched.route.authorization.resolver === 'machine' ? 0 : false, revokedBy: member?.id });
          if (authorization.action === 'owner') return Response.json({ error: 'not_owner' }, { status: 403 });
          if (matched.route.authority === 'admin') return forbiddenToMember();
          return Response.json({ error: 'not_found' }, { status: 404 });
        }
        if (matched.route.authority === 'account') return await matched.route.handler(env, { ...context, member });
        await stampRequest(env.db, now);
        return await matched.route.handler(env, { ...context, member: member! });
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
      auth = await authenticateServerMemberToken(env.db, await sha256Hex(presented), now, expiryAdmissionOf(matched?.route));
    } catch (err) {
      if (!(err instanceof SchemaMismatchError)) throw err;
      emit({ kind: 'schema_mismatch', expected: err.expected, found: err.found });
      if (!matched) return unavailable();
      return unavailableFor(matched.route);
    }
    if (!auth) {
      const digest = await sha256Hex(presented);
      if (matched?.route.auth === 'member' && matched.route.legacyRunRoute === true && matched.route.path === '/runs/update') {
        const released = await releasedRunCredential(env.db, digest, now);
        if (released !== null) {
          if (!(await env.tokenLimit.limit({ key: released.tokenId })).success) return limited();
          if (!protocolSupported(request)) return unsupportedProtocol();
          const projectId = requestedProject(request);
          const body = await readBoundedBody(request, MAX_BODY_BYTES);
          if (projectId !== null && body.ok) {
            const admission = await admitRunControl(env, released, projectId, matched.route.path, body.text, now);
            if (admission.held && admission.settled !== undefined && await authorizeHttp(env, matched.route.authorization, await runSubject(env, admission.run, released.tokenId), { projectId, run: admission.run, body: body.text })) return withProtocol(admission.settled);
          }
          return anonymous();
        }
      }
      emit({ kind: 'auth_failed', credential: 'member', matched: matched !== null, source: (await sha256Hex(source)).slice(0, 16) });
      // A superseded credential presented anywhere but the refresh route is recorded and
      // answered 401 like any other: a hook that lost a rotation race, or a bridge that
      // built its headers before the rotation, re-reads the registry and carries on. A
      // member asks to rotate only the token its registry holds, under the registry lock,
      // so a superseded one on the refresh route means a second holder rotated the
      // lineage: every live row of it is revoked, the second holder's included — while the
      // presented row's issue falls inside the idle window. One issued earlier, from a backup or
      // a log, is refused like any other and ends nothing.
      const replay = await detectLineageReplay(env.db, digest, now);
      const rotating = replay !== null && asksToRotate(matched?.route) && replay.issuedAt + MEMBER_LINEAGE_IDLE_MS > now;
      if (replay !== null) {
        const revoked = rotating ? (await revokeMemberLineage(env.db, replay.tokenId, now, LINEAGE_REPLAY_REVOKER)).revoked : 0;
        emit({
          kind: 'lineage_replayed', memberId: replay.memberId, tokenId: replay.tokenId,
          lineageRoot: replay.lineageRoot, successorId: replay.successorId,
          sinceActivationMs: now - replay.activatedAt,
          withinHookRace: now - replay.activatedAt <= LINEAGE_REPLAY_GRACE_MS,
          revoked,
        });
      }
      if (rotating || await revokedForReplay(env.db, digest)) return (await env.sourceLimit.limit({ key: source })).success ? replayRevoked() : limited();
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
      auth = await authenticateGrant(env.db, await sha256Hex(key), now);
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
      const subject: AuthorizationSubject = { kind: 'grant', deploymentId: await deploymentIdentity(env.db), transport: 'http', live: true, projectId: auth.projectId };
      if (!await authorizeHttp(env, route.authorization, subject, { projectId: auth.projectId, body: body.text })) return unauthorized();
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
      const answered = await admitted(request, env, auth, matched, url, now);
      return answered;
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
    // Run control resolves its dispatch principal before member Project resolution.
    if (route.legacyRunRoute === true) {
      if (auth.memberId !== HARNESS_MEMBER_ID && !('retired' in route && route.retired === true)) return refuse(auth, shapeOf(route), RUN_SCOPE, 'run_scope');
      if (route.bodyMode !== 'json') return refuse(auth, shapeOf(route), RUN_SCOPE, 'run_scope');
      return asRunControl(request, env, auth, route, now);
    }
    // A run credential reaches only a declared run surface and cannot refresh.
    if (auth.memberId === HARNESS_MEMBER_ID) {
      if (servesRun(route)) return asRun(request, env, auth, route, now);
      return refuse(auth, shapeOf(route), RUN_SCOPE, 'run_scope');
    }
    // A credential its issuer minted not to rotate is one an orchestrator hands to every
    // sandbox it starts through the environment. It is refused every route that mints an
    // authority able to outlive it, before its body is read or its role is, whether live or
    // lapsed: the refresh, so no holder of a copy can mint a successor and fork its lineage;
    // the GitHub link, whose dashboard session reaches invitations and new runtimes; and the
    // worker's claim and repository, which answer a run credential, the provider key its
    // harness reads, and a repository credential. It lives out its TTL or a Stop, and is
    // renewed by minting another.
    if (mintsAuthority(route) && !auth.rotates) return refuse(auth, shapeOf(route), asksToRotate(route) ? NON_ROTATING : NON_ROTATING_AUTHORITY, 'non_rotating');
    if (auth.machineId === null) return refuse(auth, shapeOf(route), NO_MACHINE_IDENTITY, 'no_machine_identity');

    // #1151 — worker mode. A Deployment-scoped route names no Project, so it is
    // answered ahead of the Project header the rest of this function requires.
    // Who may reach it is decided here rather than in a handler: the answer to a
    // claim carries a minted run credential and a Deployment credential opened
    // for the harness, so a fourth route added later cannot forget the check.
    if (deploymentScoped(route)) return await asDeployment(request, env, auth, auth.machineId, route, now);
    if (credentialScoped(route)) return await asCredential(request, env, auth, auth.machineId, route, now);

    // Only a declared protocol handler can receive a request without a default Project.
    const projectId = requestedProject(request);
    if (!request.headers.has(PROJECT_HEADER) && route.bodyMode === 'json' && route.unbound !== undefined) {
      const body = await readBoundedBody(request, MAX_BODY_BYTES);
      if (!body.ok) return refuse(auth, shapeOf(route), body.reason, 'body_cap');
      if (!await authorizeHttp(env, route.authorization, await memberSubject(env.db, auth.memberId, 'http'), { body: body.text })) return refuse(auth, shapeOf(route), NOT_ADMIN, 'not_admin');
      return route.unbound(env, { memberId: auth.memberId, machineId: auth.machineId, tokenId: auth.tokenId, body: body.text, now });
    }
    if (projectId === null) return refuse(auth, shapeOf(route), NO_PROJECT, 'no_project');

    /**
     * Member Access spans the Deployment, so a Project the server has not seen is
     * resolved into existence rather than refused. The bound is the Deployment's, not
     * this member's: a credential naming fresh Projects fills a table no per-member
     * bound covers.
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
        if (!await authorizeHttp(env, route.authorization, await memberSubject(env.db, auth.memberId, 'http'), { projectId, machineId: auth.machineId, tokenId: auth.tokenId, params })) return refuse(auth, shapeOf(route), NOT_ADMIN, 'not_admin');
        const limit = await resolved();
        if (limit !== null) return limit;
        return await route.handler(env, request, { projectId, machineId: auth.machineId, tokenId: auth.tokenId, now, clock: deps.now, contentLength, params });
      } catch (err) {
        return failed(env, auth, route, err);
      }
    }

    try {
      const body = await readBoundedBody(request, MAX_BODY_BYTES);
      if (!body.ok) return refuse(auth, shapeOf(route), body.reason, 'body_cap');
      if (route.authorization.action === 'bootstrap') {
        const malformed = emptyBodyRefusal(body.text);
        if (malformed !== null) return refuse(auth, shapeOf(route), malformed.reason, malformed.classifier);
      }
      if (!await authorizeHttp(env, route.authorization, await memberSubject(env.db, auth.memberId, 'http'), { projectId, machineId: auth.machineId, tokenId: auth.tokenId, body: body.text, params })) return route.authorization.action === 'bootstrap' ? refuse(auth, shapeOf(route), LINK_REQUIRES_ADMIN, 'link_requires_admin') : refuse(auth, shapeOf(route), NOT_ADMIN, 'not_admin');
      const limit = await resolved();
      if (limit !== null) return limit;
      const answered = await route.handler(env, {
        projectId, memberId: auth.memberId, machineId: auth.machineId, tokenId: auth.tokenId,
        expiresAt: auth.expiresAt, lineageRoot: auth.lineageRoot, lineageStartedAt: auth.lineageStartedAt, runtime: auth.runtime,
        ...machineContractHeaders(request), body: body.text, bodyBytes: body.bytes, now, clock: deps.now, origin: url.origin, turnEnd: request.headers.get(TURN_END_HEADER) === '1',
      });
      return answered;
    } catch (err) {
      return failed(env, auth, route, err);
    }
  }

  /** A request answered on the presented credential alone — its refresh. It names no Project and creates none, whatever header it carries. */
  async function asCredential(request: Request, env: ServerEnv, auth: MemberAuth, machineId: string, route: CredentialRoute, now: number): Promise<Response> {
    try {
      const body = await readBoundedBody(request, MAX_BODY_BYTES);
      if (!body.ok) return refuse(auth, shapeOf(route), body.reason, 'body_cap');
      if (route.authorization.action === 'bootstrap') {
        const malformed = emptyBodyRefusal(body.text);
        if (malformed !== null) return refuse(auth, shapeOf(route), malformed.reason, malformed.classifier);
      }
      if (!await authorizeHttp(env, route.authorization, await memberSubject(env.db, auth.memberId, 'http'), { machineId, tokenId: auth.tokenId, body: body.text })) {
        if (route.authorization.action === 'bootstrap') return refuse(auth, shapeOf(route), LINK_REQUIRES_ADMIN, 'link_requires_admin');
        if (route.authorization.action === 'owner') return Response.json({ persisted: false, code: 'not_owner', reason: 'not_owner' });
        return refuse(auth, shapeOf(route), NOT_ADMIN, 'not_admin');
      }
      return await route.credential(env, {
        memberId: auth.memberId, machineId, tokenId: auth.tokenId, expiresAt: auth.expiresAt,
        lineageRoot: auth.lineageRoot, lineageStartedAt: auth.lineageStartedAt, runtime: auth.runtime, ...machineContractHeaders(request), body: body.text, now,
      });
    } catch (err) {
      return failed(env, auth, route, err);
    }
  }

  /**
   * A Deployment-scoped request: a worker's claim, lease or end.
   *
   * The declaration admits a live administrator after bounded parsing. Lease
   * and end refusals tell an authenticated worker that its authority has ended.
   */
  async function asDeployment(request: Request, env: ServerEnv, auth: MemberAuth, machineId: string, route: DeploymentRoute, now: number): Promise<Response> {
    try {
      const body = await readBoundedBody(request, MAX_BODY_BYTES);
      if (!body.ok) return refuse(auth, shapeOf(route), body.reason, 'body_cap');
      const subject = await memberSubject(env.db, auth.memberId, 'http');
      if (!await authorizeHttp(env, route.authorization, subject, { machineId, tokenId: auth.tokenId, body: body.text })) {
        if (!subject.live && ['/worker/lease', '/worker/end', '/worker/repository'].includes(route.path)) return Response.json({ persisted: true, [route.path === '/worker/end' ? 'ended' : 'held']: false, reason: 'the lease is no longer held' });
        return refuse(auth, shapeOf(route), NOT_ADMIN, 'not_admin');
      }
      return await route.deployment(env, { memberId: auth.memberId, machineId, tokenId: auth.tokenId, body: body.text, now, clock: deps.now });
    } catch (err) {
      return failed(env, auth, route, err);
    }
  }

  /**
   * The run principal: the one live run this credential dispatched, in the run's
   * own Project. The header must name that Project — one Project per request is
   * an invariant every principal obeys — and nothing resolves a Project into
   * existence here: the run row's key already guarantees it exists, and a run
   * never spends a Project seat. The body is read as on every json route.
   */
  async function asRun(request: Request, env: ServerEnv, auth: MemberAuth, route: RunRoute, now: number): Promise<Response> {
    const projectId = requestedProject(request);
    if (projectId === null) return refuse(auth, shapeOf(route), NO_PROJECT, 'no_project');
    const held = await heldRunOfCredential(env, auth, now);
    if (held === null) return refuse(auth, shapeOf(route), NO_LIVE_RUN, 'no_run');
    if (projectId !== held.projectId) return refuse(auth, shapeOf(route), RUN_PROJECT_MISMATCH, 'project_mismatch', { runId: held.id });
    try {
      const body = await readBoundedBody(request, MAX_BODY_BYTES);
      if (!body.ok) return refuse(auth, shapeOf(route), body.reason, 'body_cap');
      const subject = await runSubject(env, held, auth.tokenId);
      if (!await authorizeHttp(env, route.authorization, subject, { projectId, run: held, body: body.text })) return refuse(auth, shapeOf(route), RUN_SCOPE, 'run_scope');
      return await route.run(env, { projectId: held.projectId, run: held, tokenId: auth.tokenId, body: body.text, now, clock: deps.now });
    } catch (err) {
      return failed(env, auth, route, err);
    }
  }

  /** The retained runtime channel receives only its credential-bound dispatch and Project. */
  async function asRunControl(request: Request, env: ServerEnv, auth: MemberAuth, route: Extract<MemberRoute, { bodyMode: 'json'; handler: unknown }>, now: number): Promise<Response> {
    const receipt = async (response: Response): Promise<Response> => {
      const result = await response.clone().json() as Record<string, unknown>;
      const code = runControlRefusalCode(result.code);
      if (result.persisted !== false || code === null) return response;
      const refusalId = await recordRunControlRefusal(env.db, auth.tokenId, code);
      return refusalId === null ? response : Response.json({ ...result, refusalId }, { status: response.status, headers: response.headers });
    };
    const projectId = requestedProject(request);
    if (projectId === null) return receipt(refuse(auth, shapeOf(route), NO_PROJECT, 'no_project'));
    const body = await readBoundedBody(request, MAX_BODY_BYTES);
    if (!body.ok) return receipt(refuse(auth, shapeOf(route), body.reason, 'body_cap'));
    if (auth.machineId === null) return receipt(refuse(auth, shapeOf(route), NO_MACHINE_IDENTITY, 'no_machine_identity'));
    const context = { projectId, memberId: auth.memberId, machineId: auth.machineId,
      tokenId: auth.tokenId, expiresAt: auth.expiresAt, lineageRoot: auth.lineageRoot, lineageStartedAt: auth.lineageStartedAt,
      runtime: auth.runtime, body: body.text, bodyBytes: body.bytes, now, clock: deps.now, origin: new URL(request.url).origin };
    if (route.retired === true) return refuse(auth, shapeOf(route), `${route.path} is retired: ${RETIRED_RUN_ROUTES[route.path]}`, 'route_retired');
    const admission = await admitRunControl(env, auth, projectId, route.path, body.text, now);
    if (!admission.held) return receipt(refuse(auth, shapeOf(route), NO_LIVE_RUN, 'no_run'));
    if (!await authorizeHttp(env, route.authorization, await runSubject(env, admission.run, auth.tokenId), { projectId, run: admission.run, body: body.text })) return receipt(refuse(auth, shapeOf(route), RUN_SCOPE, 'run_scope'));
    if (admission.settled !== undefined) return admission.settled;
    const principal = { ...context, runDeadline: runDeadline(admission.run) };
    const guarded = CONTROL_CAPABILITIES[route.path]?.writeGuard === 'batch'
      ? { ...env, db: runWriteStore(env.db, projectId, admission.run.id, runtimeCaller(principal)) } : env;
    let answered: Response;
    try { answered = await route.handler(guarded, principal); }
    catch (error) {
      if (!(error instanceof RunWriteExpired)) throw error;
      answered = refuse(auth, shapeOf(route), NO_LIVE_RUN, 'no_run');
    }
    await recordRunRoute(env, auth, route.path, answered, admission.run, now);
    return receipt(answered);
  }

  async function handleRequest(request: Request, env: ServerEnv): Promise<Response> {
    const route = matchRoute(request.method, new URL(request.url).pathname)?.route;
    const raw = route?.auth === 'session' && 'raw' in route && route.raw !== undefined;
    try {
      return stamp(await run(request, env), raw);
    } catch (err) {
      emit({ kind: 'request_error', error_class: classify(err, errorClassifierOf(env)) });
      return stamp(unavailable(), raw);
    }
  }

  return { handleRequest };
}
