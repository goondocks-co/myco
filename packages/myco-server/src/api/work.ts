/**
 * `GET /api/work`: Myco's work over a window of instants, across Projects, optionally only the Projects named.
 *
 * Today lists the first page of runs beside the day's sessions. Myco's work groups the same counts by outcome,
 * retrieves later evidence pages by cursor, and adds upkeep and cost. Named windows answer full-window counts from
 * maintained rollups when the range is a supported UTC window, one UTC day or seven; any other range answers its
 * paged evidence with no totals. A read naming no window covers the last seven UTC days through today.
 *
 * A member reads all of it, cost included: what the Deployment's own work produced and spent is not an admin's alone.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { badRequest, instantParam, notFound, ok, projectSetParam, resolveProjectSet } from './scope.js';
import { DEFAULT_WORK_WINDOW_DAYS, defaultWorkWindow, MAX_WORK_WINDOW_MS, readWork } from '../read/work.js';
import { readWorkNow } from '../read/work-now.js';
import { isAdmin } from '../auth/roles.js';

function workCursor(raw: string | null): { at: number; projectId: string; id: string } | undefined | Response {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.length === 3 && Number.isSafeInteger(value[0])
      && typeof value[1] === 'string' && value[1].length > 0
      && typeof value[2] === 'string' && value[2].length > 0) {
      return { at: value[0] as number, projectId: value[1], id: value[2] };
    }
  } catch { /* malformed cursor */ }
  return badRequest('malformed cursor');
}

export async function handleWork(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const named = projectSetParam(ctx.url);
  if (named instanceof Response) return named;
  const since = instantParam(ctx.url, 'since');
  if (since instanceof Response) return since;
  const until = instantParam(ctx.url, 'until');
  if (until instanceof Response) return until;
  const fallback = since === undefined && until === undefined ? defaultWorkWindow(ctx.now) : null;
  const end = until ?? fallback?.until ?? ctx.now;
  const start = since ?? fallback?.since ?? end - DEFAULT_WORK_WINDOW_DAYS * 86_400_000;
  if (start >= end) return badRequest('since must be before until');
  if (end - start > MAX_WORK_WINDOW_MS) return badRequest(`a window spans at most ${MAX_WORK_WINDOW_MS / 86_400_000} days`);
  const cursor = workCursor(ctx.url.searchParams.get('cursor'));
  if (cursor instanceof Response) return cursor;
  const set = await resolveProjectSet(env.db, ctx.member, named);
  if (set === null) return notFound();
  return ok(await readWork(env.db, set, start, end, cursor, ctx.now));
}

/**
 * `GET /api/presence`: a person is using the dashboard. It answers nothing else; the request pipeline records the
 * activity, as it does for every request that is not the dashboard fetching on its own.
 */
export async function handlePresence(_env: ServerEnv, _ctx: OwnerContext): Promise<Response> {
  return ok({ present: true });
}

/**
 * `GET /api/work/now`: what Myco is doing now — running, waiting and why, and what needs someone — over one Project
 * (`project`) or every visible Project. The dashboard's live refresh reads it every tick, so it is bounded on every
 * store; a runner's sign-in detail is an administrator's, as on Runners.
 */
export async function handleWorkNow(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const named = projectSetParam(ctx.url);
  if (named instanceof Response) return named;
  if (named.length > 1) return badRequest('name one project, or none for every project');
  const set = await resolveProjectSet(env.db, ctx.member, named);
  if (set === null) return notFound();
  let cursor: { priority: number; activity: number; projectId: string } | null = null;
  const rawCursor = ctx.url.searchParams.get('cursor');
  if (rawCursor !== null) {
    try {
      const value: unknown = JSON.parse(rawCursor);
      if (typeof value !== 'object' || value === null || !('priority' in value) || (value.priority !== 0 && value.priority !== 1) || !('activity' in value) || !('projectId' in value)
        || typeof value.activity !== 'number' || !Number.isFinite(value.activity) || typeof value.projectId !== 'string') {
        return badRequest('cursor must be the continuation value returned by the previous Today page');
      }
      cursor = { priority: value.priority, activity: value.activity, projectId: value.projectId };
    } catch { return badRequest('cursor must be the continuation value returned by the previous Today page'); }
  }
  return ok(await readWorkNow(env, named.length === 1 ? { projectId: named[0]! } : { all: true }, ctx.now, isAdmin(ctx.member.role), cursor));
}
