import type { Env } from './env.js';
import { matchRoute } from './routes.js';
import { authenticateServerMemberToken, MEMBER_TOKEN_PATTERN, type MemberAuth } from './auth/tokens.js';
import { HSTS_MAX_AGE_SECONDS, MEMBER_TOKEN_BYTE_QUOTA, RETRY_AFTER_SECONDS } from './constants.js';
import { sha256Hex } from './hash.js';
import { readBoundedBody, MAX_BODY_BYTES } from './ingest/body.js';
import { classify, emit, SchemaMismatchError } from './telemetry.js';

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

const RETRY_AFTER = { 'retry-after': String(RETRY_AFTER_SECONDS) };
const unauthorized = () => Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'www-authenticate': 'Bearer realm="myco"' } });
const unavailable = () => Response.json({ error: 'unavailable' }, { status: 503, headers: RETRY_AFTER });
const limited = () => Response.json({ error: 'rate limited' }, { status: 429, headers: RETRY_AFTER });
const QUOTA_REASON = 'token write quota exceeded';

/** A terminal refusal of the caller's own request: 200, never retried. */
function refuse(auth: MemberAuth, reason: string): Response {
  emit({ kind: 'ingest_refused', projectId: auth.projectId, tokenId: auth.tokenId, reason });
  return Response.json({ persisted: false, reason });
}

/** The presented credential, or null unless it has the minted token shape. The scheme name is case-insensitive. */
function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header === null ? null : /^bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  return MEMBER_TOKEN_PATTERN.test(match[1]) ? match[1] : null;
}

/** True when the token's stored volume plus this body would exceed the quota; read fresh after a constraint failure. */
async function overQuota(env: Env, tokenId: string, bodyBytes: number): Promise<boolean> {
  const row = await env.MYCO_DB.prepare(`SELECT bytes_written FROM member_tokens WHERE id = ?`).bind(tokenId).first<{ bytes_written: number }>();
  return row !== null && row.bytes_written + bodyBytes > MEMBER_TOKEN_BYTE_QUOTA;
}

/** Order: route → public → source identity → credential shape → authenticate → route kind → token limit → body → quota → handler. The source bucket is charged only when a request ends without a member identity (no credential, malformed credential, or a digest that matches no live token): that refusal answers 429 once the bucket is exhausted and 401 before. An authenticated member never charges the source bucket and is never refused by source, on matched and unmatched routes alike. After authentication, a failure of the caller's own request answers 200 with a reason and is never retried; a failure on the server's side answers 503 with retry-after and is retried. */
export function createServer(deps: ServerDeps) {
  async function run(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = matchRoute(request.method, url.pathname);
    const now = deps.now();

    if (route?.auth === 'public') return route.handler(request);

    const source = deps.sourceOf(request);
    if (source === null) {
      emit({ kind: 'no_source_identity', matched: route !== null });
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
      return unavailable();
    }
    if (!auth) {
      emit({ kind: 'auth_failed', matched: route !== null, source: (await sha256Hex(source)).slice(0, 16) });
      return anonymous();
    }
    if (!route) return unauthorized();
    if (!(await env.TOKEN_LIMIT.limit({ key: auth.tokenId })).success) return limited();

    let bodyBytes = 0;
    try {
      const body = await readBoundedBody(request, MAX_BODY_BYTES);
      if (!body.ok) return refuse(auth, body.reason);
      bodyBytes = body.bytes;
      if (auth.bytesWritten + body.bytes > MEMBER_TOKEN_BYTE_QUOTA) return refuse(auth, QUOTA_REASON);
      return await route.handler(env, {
        projectId: auth.projectId, machineId: auth.machineId, tokenId: auth.tokenId,
        body: body.text, bodyBytes: body.bytes, now,
      });
    } catch (err) {
      const errorClass = classify(err);
      if (errorClass === 'quota') return refuse(auth, QUOTA_REASON);
      if (errorClass === 'constraint' && (await overQuota(env, auth.tokenId, bodyBytes))) return refuse(auth, QUOTA_REASON);
      emit({ kind: 'ingest_error', projectId: auth.projectId, tokenId: auth.tokenId, error_class: errorClass });
      return Response.json({ persisted: false, reason: 'unavailable' }, { status: 503, headers: RETRY_AFTER });
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
