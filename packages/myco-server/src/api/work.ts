/**
 * `GET /api/work`: Myco's work over a window of instants, across Projects, optionally only the Projects named.
 *
 * Today lists the first page of runs beside the day's sessions and heads the page with full-window counts. Myco's work
 * groups the same counts by outcome, retrieves later evidence pages by cursor, and adds upkeep and cost. Each response
 * reads its counts and evidence from one snapshot.
 *
 * A member reads all of it, cost included: what the Deployment's own work produced and spent is not an admin's alone.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { badRequest, instantParam, notFound, ok, projectSetParam, resolveProjectSet } from './scope.js';
import { DEFAULT_WORK_WINDOW_MS, MAX_WORK_WINDOW_MS, readWork } from '../read/work.js';

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
  const end = until ?? ctx.now;
  const start = since ?? end - DEFAULT_WORK_WINDOW_MS;
  if (start >= end) return badRequest('since must be before until');
  if (end - start > MAX_WORK_WINDOW_MS) return badRequest(`a window spans at most ${MAX_WORK_WINDOW_MS / 86_400_000} days`);
  const cursor = workCursor(ctx.url.searchParams.get('cursor'));
  if (cursor instanceof Response) return cursor;
  const set = await resolveProjectSet(env.db, ctx.member, named);
  if (set === null) return notFound();
  return ok(await readWork(env.db, set, start, end, cursor));
}
