/**
 * `GET /api/work`: Myco's work over a window of instants, across Projects, optionally only the Projects named.
 *
 * One read, and one answer, for both pages that show it. Today lists the runs beside the day's sessions and heads the
 * page with the counts; Myco's work groups the same counts by outcome, lists the same runs under them, and adds the
 * upkeep line and the cost. Served as one call, the counts a page shows and the runs it lists always come from one
 * snapshot, and either page is one round trip.
 *
 * A member reads all of it, cost included: what the Deployment's own work produced and spent is not an admin's alone.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { badRequest, instantParam, notFound, ok, projectSetParam, resolveProjectSet } from './scope.js';
import { DEFAULT_WORK_WINDOW_MS, MAX_WORK_WINDOW_MS, readWork } from '../read/work.js';

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
  const set = await resolveProjectSet(env.db, ctx.member, named);
  if (set === null) return notFound();
  return ok(await readWork(env.db, set, start, end));
}
