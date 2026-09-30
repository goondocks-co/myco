/**
 * Sessions, spores and plans read across Projects: `/api/sessions`, `/api/spores` and `/api/plans`.
 *
 * Each takes the filters of its per-Project twin, plus a repeatable `project=` naming the Projects it covers; sessions
 * and spores take a window from a start instant (inclusive) to an end instant (exclusive), and plans a start instant; naming no Project covers every Project the caller may see. A named Project the caller may not see answers 404,
 * as the twin does. Rows carry their `projectId`, and each list pages exactly as its twin pages.
 */
import { nameOwnMachines, ownMachineNames } from '../read/capture.js';
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { badRequest, instantParam, notFound, ok, projectSetParam, resolveProjectSet } from './scope.js';
import { paging, sessionFilters } from './sessions.js';
import { listSessionSummariesAcross } from '../read/sessions.js';
import { countSporesAcross, listSporesAcross, sporeFacets, type ListSporesOptions } from '../core/spores.js';
import { pagePlansAcross, planTotals, PLAN_STATUS_MESSAGE, WRITABLE_PLAN_STATUSES } from '../read/plans.js';
import { decodeCursor, type ProjectSet } from '../read/scope.js';
import { MAX_PAGE } from './intelligence.js';

const clampLimit = (raw: string | null): number => {
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_PAGE) : 50;
};

const offsetOf = (raw: string | null): number => {
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/** The Projects this request covers, or the answer that refuses it. */
async function projectSetOf(env: ServerEnv, ctx: OwnerContext): Promise<ProjectSet | Response> {
  const named = projectSetParam(ctx.url);
  if (named instanceof Response) return named;
  return (await resolveProjectSet(env.db, ctx.member, named)) ?? notFound();
}

/** `GET /api/sessions`: the session list across Projects, newest first, with the per-Project list's filters, an agent, and a window of starts. */
export async function handleSessionsAcross(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const set = await projectSetOf(env, ctx);
  if (set instanceof Response) return set;
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  const filters = sessionFilters(ctx.url);
  if (filters instanceof Response) return filters;
  const listed = await listSessionSummariesAcross(env.db, set, { ...page, ...filters }, ctx.now);
  return ok({ ...listed, rows: nameOwnMachines(listed.rows, await ownMachineNames(env.db, ctx.member.id, ctx.now)) });
}

/**
 * `GET /api/spores`: the spore list across Projects, newest first, written inside a window, paged by offset as the per-Project list is. The
 * first page (`offset` 0) carries `facets`: the count of each type and of each Project under the other filters.
 */
export async function handleSporesAcross(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const set = await projectSetOf(env, ctx);
  if (set instanceof Response) return set;
  const since = instantParam(ctx.url, 'since');
  if (since instanceof Response) return since;
  const until = instantParam(ctx.url, 'until');
  if (until instanceof Response) return until;
  const text = (name: string): string | undefined => ctx.url.searchParams.get(name) ?? undefined;
  const options: ListSporesOptions = {
    observationType: text('type'),
    status: text('status'),
    sessionId: text('session'),
    search: text('q'),
    createdFrom: since,
    createdTo: until,
    limit: clampLimit(ctx.url.searchParams.get('limit')),
    offset: offsetOf(ctx.url.searchParams.get('offset')),
  };
  const [spores, total, facets] = await Promise.all([
    listSporesAcross(env.db, set, options),
    countSporesAcross(env.db, set, options),
    options.offset === 0 ? sporeFacets(env.db, set, options) : Promise.resolve(undefined),
  ]);
  return ok({ spores, total, maxPage: MAX_PAGE, ...(facets === undefined ? {} : { facets }) });
}

/**
 * `GET /api/plans`: the plan list across Projects, newest edit first, a page at a time; `status` must be one the
 * catalogue holds, and `q` matches a plan's title or inline body. The first page (no cursor) carries `totals`: how
 * many plans of each status the other filters admit, so each status column can count its plans.
 */
export async function handlePlansAcross(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const set = await projectSetOf(env, ctx);
  if (set instanceof Response) return set;
  const status = ctx.url.searchParams.get('status');
  if (status !== null && !WRITABLE_PLAN_STATUSES.has(status)) return badRequest(PLAN_STATUS_MESSAGE);
  const since = instantParam(ctx.url, 'since');
  if (since instanceof Response) return since;
  const cursor = ctx.url.searchParams.get('cursor');
  if (cursor !== null && decodeCursor(cursor) === null) return badRequest('malformed cursor');
  const q = ctx.url.searchParams.get('q') ?? undefined;
  const [page, totals] = await Promise.all([
    pagePlansAcross(env.db, set, {
      ...(status === null ? {} : { status }),
      ...(since === undefined ? {} : { since }),
      ...(q === undefined ? {} : { q }),
      limit: clampLimit(ctx.url.searchParams.get('limit')),
      ...(cursor === null ? {} : { cursor }),
    }),
    cursor === null ? planTotals(env.db, set, { since, q }) : Promise.resolve(undefined),
  ]);
  return ok({ plans: page.rows, cursor: page.cursor, maxPage: MAX_PAGE, ...(totals === undefined ? {} : { totals }) });
}
