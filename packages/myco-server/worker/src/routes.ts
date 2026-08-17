import type { Env } from './env.js';
import type { RouteContext } from './context.js';
import { handleEvents } from './ingest/events.js';

/** Public handlers receive the request only; they cannot reach storage or bindings. */
export type PublicHandler = (request: Request) => Promise<Response>;
/** Member handlers receive the bindings and the consumed request as context; the request stream is spent by the pipeline. */
export type MemberHandler = (env: Env, ctx: RouteContext) => Promise<Response>;

export type Route =
  | { method: string; path: string; auth: 'public'; handler: PublicHandler }
  | { method: string; path: string; auth: 'member'; handler: MemberHandler };

async function health(): Promise<Response> {
  return Response.json({ ok: true });
}

export const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/health', auth: 'public', handler: health },
  { method: 'POST', path: '/events', auth: 'member', handler: handleEvents },
];

export function matchRoute(method: string, pathname: string): Route | null {
  return ROUTES.find((r) => r.method === method && r.path === pathname) ?? null;
}
