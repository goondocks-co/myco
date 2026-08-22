import type { Env } from './env.js';
import type { AuthContext, OwnerContext, RouteContext, StreamContext } from './context.js';
import { clearCookie } from './auth/owner/cookie.js';
import { handleCallback, handleLogin } from './auth/owner/routes.js';
import { handleCreateProject, handleProjects } from './api/projects.js';
import { handleStatus } from './api/status.js';
import { handleBlobRead } from './api/blobs.js';
import { handleMintToken, handleRevokeToken, handleTokenActivity, handleTokens } from './api/tokens.js';
import { handleProjectSessions, handleSession, handleSessionChildren, handleTranscript } from './api/sessions.js';
import { MAX_BLOB_BYTES } from './constants.js';
import { handleRefresh } from './auth/refresh.js';
import { handleBlob } from './ingest/blobs.js';
import { handleEvents } from './ingest/events.js';

/** Public handlers receive the request only; they cannot reach storage or bindings. */
export type PublicHandler = (request: Request) => Promise<Response>;
/** Member handlers on json routes receive the bindings and the consumed request as context; the request stream is spent by the pipeline. */
export type MemberHandler = (env: Env, ctx: RouteContext) => Promise<Response>;
/** Member handlers on stream routes receive the unread request; the handler alone consumes the body. */
export type StreamHandler = (env: Env, request: Request, ctx: StreamContext) => Promise<Response>;
/** Auth handlers require no credential but do need the owner configuration and outbound fetch. They receive a narrowed context and never an `Env`, so a credential-free route still cannot reach storage or bindings by type. */
export type AuthHandler = (request: Request, ctx: AuthContext) => Promise<Response>;
/** Owner handlers run only after a valid owner session; they receive the bindings and the resolved session. */
export type OwnerHandler = (env: Env, ctx: OwnerContext) => Promise<Response>;

/** The key a member route answers under: `{<shape>: true|false, …}` on every outcome after authentication, refusals and 503s included. */
export type Shape = 'persisted' | 'stored' | 'refreshed';

/** `quotaPrecheck: false` marks a member route whose writes are not charged to the byte quota: the pipeline skips the byte pre-check and never reads a constraint failure as a quota refusal. Absent, the route is charged. */
export type Route =
  | { method: string; path: string; auth: 'public'; bodyMode: 'none'; handler: PublicHandler }
  | { method: string; path: string; auth: 'member'; bodyMode: 'json'; shape: 'persisted' | 'refreshed'; quotaPrecheck?: boolean; handler: MemberHandler }
  | { method: string; path: string; pattern: RegExp; auth: 'member'; bodyMode: 'stream'; shape: 'stored'; quotaPrecheck?: boolean; maxBodyBytes: number; handler: StreamHandler }
  | { method: string; path: string; auth: 'auth'; handler: AuthHandler }
  | { method: string; path: string; pattern?: RegExp; auth: 'owner'; handler: OwnerHandler };

async function health(): Promise<Response> {
  return Response.json({ ok: true });
}

export const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/health', auth: 'public', bodyMode: 'none', handler: health },
  { method: 'POST', path: '/events', auth: 'member', bodyMode: 'json', shape: 'persisted', handler: handleEvents },
  { method: 'POST', path: '/blobs/{sha256}', pattern: /^\/blobs\/(?<key>[0-9a-f]{64})$/, auth: 'member', bodyMode: 'stream', shape: 'stored', maxBodyBytes: MAX_BLOB_BYTES, handler: handleBlob },
  { method: 'POST', path: '/tokens/refresh', auth: 'member', bodyMode: 'json', shape: 'refreshed', quotaPrecheck: false, handler: handleRefresh },
  { method: 'GET', path: '/api/status', auth: 'owner', handler: handleStatus },
  { method: 'GET', path: '/api/projects', auth: 'owner', handler: handleProjects },
  { method: 'POST', path: '/api/projects', auth: 'owner', handler: handleCreateProject },
  { method: 'GET', path: '/api/projects/{projectId}/sessions', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions$/, auth: 'owner', handler: handleProjectSessions },
  { method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[A-Za-z0-9._:-]{1,128})$/, auth: 'owner', handler: handleSession },
  { method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/{child}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[A-Za-z0-9._:-]{1,128})\/(?<child>prompts|tool-calls|responses|plans|attachments)$/, auth: 'owner', handler: handleSessionChildren },
  { method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/transcript', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[A-Za-z0-9._:-]{1,128})\/transcript$/, auth: 'owner', handler: handleTranscript },
  { method: 'GET', path: '/api/projects/{projectId}/blobs/{key}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/blobs\/(?<key>[0-9a-f]{64})$/, auth: 'owner', handler: handleBlobRead },
  { method: 'GET', path: '/api/projects/{projectId}/tokens', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/tokens$/, auth: 'owner', handler: handleTokens },
  { method: 'POST', path: '/api/projects/{projectId}/tokens', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/tokens$/, auth: 'owner', handler: handleMintToken },
  { method: 'POST', path: '/api/projects/{projectId}/tokens/{tokenId}/revoke', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/tokens\/(?<tokenId>[A-Za-z0-9._-]{1,64})\/revoke$/, auth: 'owner', handler: handleRevokeToken },
  { method: 'GET', path: '/api/projects/{projectId}/tokens/{tokenId}/activity', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/tokens\/(?<tokenId>[A-Za-z0-9._-]{1,64})\/activity$/, auth: 'owner', handler: handleTokenActivity },
  { method: 'GET', path: '/auth/login', auth: 'auth', handler: handleLogin },
  { method: 'GET', path: '/auth/callback', auth: 'auth', handler: handleCallback },
  { method: 'POST', path: '/auth/logout', auth: 'owner', handler: async () => new Response(null, { status: 204, headers: { 'set-cookie': clearCookie() } }) },
];

/** A 1.4.x wire route the server does not serve; each names the event kinds (or the blob route) that carry the same capture in 2.0. A retired path is unmatched and answers 401 like any other absent path. */
export interface RetiredRoute {
  method: string;
  path: string;
  replacedBy: readonly string[];
}

export const RETIRED_ROUTES: readonly RetiredRoute[] = [
  { method: 'POST', path: '/sessions/register', replacedBy: ['session.start'] },
  { method: 'POST', path: '/sessions/unregister', replacedBy: ['session.end'] },
  { method: 'POST', path: '/events/stop', replacedBy: ['response'] },
  { method: 'POST', path: '/events/sync-transcript-prompts', replacedBy: ['prompt'] },
  { method: 'POST', path: '/routed-capture/transcript', replacedBy: ['POST /blobs/{sha256}', 'transcript.segment'] },
  { method: 'POST', path: '/routed-capture/plan', replacedBy: ['plan'] },
  { method: 'POST', path: '/context/subagent', replacedBy: ['subagent.start'] },
];

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

/** Exact method and path match for path routes; pattern routes capture their named segments. */
export function matchRoute(method: string, pathname: string): RouteMatch | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const pattern = 'pattern' in route ? route.pattern : undefined;
    if (pattern !== undefined) {
      const m = pattern.exec(pathname);
      if (m) return { route, params: { ...m.groups } };
    } else if (route.path === pathname) {
      return { route, params: {} };
    }
  }
  return null;
}
