import type { Env } from './env.js';
import type { RouteContext, StreamContext } from './context.js';
import { MAX_BLOB_BYTES } from './constants.js';
import { handleBlob } from './ingest/blobs.js';
import { handleEvents } from './ingest/events.js';

/** Public handlers receive the request only; they cannot reach storage or bindings. */
export type PublicHandler = (request: Request) => Promise<Response>;
/** Member handlers on json routes receive the bindings and the consumed request as context; the request stream is spent by the pipeline. */
export type MemberHandler = (env: Env, ctx: RouteContext) => Promise<Response>;
/** Member handlers on stream routes receive the unread request; the handler alone consumes the body. */
export type StreamHandler = (env: Env, request: Request, ctx: StreamContext) => Promise<Response>;

export type Route =
  | { method: string; path: string; auth: 'public'; bodyMode: 'none'; handler: PublicHandler }
  | { method: string; path: string; auth: 'member'; bodyMode: 'json'; handler: MemberHandler }
  | { method: string; path: string; pattern: RegExp; auth: 'member'; bodyMode: 'stream'; maxBodyBytes: number; handler: StreamHandler };

async function health(): Promise<Response> {
  return Response.json({ ok: true });
}

export const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/health', auth: 'public', bodyMode: 'none', handler: health },
  { method: 'POST', path: '/events', auth: 'member', bodyMode: 'json', handler: handleEvents },
  { method: 'POST', path: '/blobs/{sha256}', pattern: /^\/blobs\/(?<key>[0-9a-f]{64})$/, auth: 'member', bodyMode: 'stream', maxBodyBytes: MAX_BLOB_BYTES, handler: handleBlob },
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
    if (route.bodyMode === 'stream') {
      const m = route.pattern.exec(pathname);
      if (m) return { route, params: { ...m.groups } };
    } else if (route.path === pathname) {
      return { route, params: {} };
    }
  }
  return null;
}
