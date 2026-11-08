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
import { listSporePageAcross, sporeListWindow, type ListSporesOptions } from '../core/spores.js';
import { pagePlansAcross, planTotals, PLAN_STATUS_MESSAGE, WRITABLE_PLAN_STATUSES } from '../read/plans.js';
import type { ProjectSet } from '../read/scope.js';
import { decodeProjectCursor, PROJECT_CURSOR_REFUSAL } from '../read/project-cursor.js';
import { MAX_PAGE, OFFSET_REFUSAL } from './intelligence.js';
import { searchRepairRefusal } from '../core/search-repair.js';

const clampLimit = (raw: string | null): number => {
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_PAGE) : 50;
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
  const page = paging(ctx.url, { decode: decodeProjectCursor, refusal: PROJECT_CURSOR_REFUSAL });
  if (page instanceof Response) return page;
  const filters = sessionFilters(ctx.url);
  if (filters instanceof Response) return filters;
  const listed = await listSessionSummariesAcross(env.db, set, { ...page, ...filters }, ctx.now);
  return ok({ ...listed, rows: nameOwnMachines(listed.rows, await ownMachineNames(env.db, ctx.member.id, ctx.now)) });
}

/**
 * `GET /api/spores`: the spore list across Projects, newest first, written inside a window, a page at a time by the
 * `cursor` the previous page answered, with `hasMore`. `total` and, on the first page, `facets` (each type's and each
 * Project's count under the other filters) come from the maintained counters, for filters they answer: status, type, a
 * session, or a window on whole UTC days. While existing spores are still being counted the answer carries `counting:
 * 'building'` instead. A text match is a search (`/api/search`).
 */
export async function handleSporesAcross(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const set = await projectSetOf(env, ctx);
  if (set instanceof Response) return set;
  if (ctx.url.searchParams.has('offset')) return badRequest(OFFSET_REFUSAL);
  const since = instantParam(ctx.url, 'since');
  if (since instanceof Response) return since;
  const until = instantParam(ctx.url, 'until');
  if (until instanceof Response) return until;
  const text = (name: string): string | undefined => ctx.url.searchParams.get(name) ?? undefined;
  const q = text('q');
  if (q !== undefined) return badRequest(searchRepairRefusal('q', { type: 'spore', text: q, projects: set.all ? 'all' : set.projectIds,
    status: text('status'), observationType: text('type'), sessionId: text('session'), ...sporeListWindow({ createdFrom: since, createdTo: until }) }));
  const options: ListSporesOptions = {
    observationType: text('type'),
    status: text('status'),
    sessionId: text('session'),
    createdFrom: since,
    createdTo: until,
    limit: clampLimit(ctx.url.searchParams.get('limit')),
    cursor: ctx.url.searchParams.get('cursor') ?? undefined,
  };
  const listed = await listSporePageAcross(env.db, set, options);
  if (listed === null) return badRequest(PROJECT_CURSOR_REFUSAL);
  const { rows, ...page } = listed;
  return ok({ spores: rows, ...page, maxPage: MAX_PAGE });
}

/**
 * `GET /api/plans`: the plan list across Projects, newest edit first, a page at a time with `hasMore`; `status` must be
 * one the catalogue holds. The first page (no cursor) carries `totals`, how many plans of each status the Projects
 * hold, from the maintained counters (or `counting: 'building'` while existing plans are still being counted); with
 * a start instant there are no totals. A text match is a search (`/api/search`).
 */
export async function handlePlansAcross(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const set = await projectSetOf(env, ctx);
  if (set instanceof Response) return set;
  const status = ctx.url.searchParams.get('status');
  const q = ctx.url.searchParams.get('q');
  // The plan list's start bounds the last edit, and search bounds when a plan is written: search cannot narrow the same way.
  if (q !== null) return badRequest(searchRepairRefusal('q', { type: 'plan', text: q, projects: set.all ? 'all' : set.projectIds, status: status ?? undefined,
    unsupported: ctx.url.searchParams.has('since') ? ['since (the last edit)'] : [] }));
  if (status !== null && !WRITABLE_PLAN_STATUSES.has(status)) return badRequest(PLAN_STATUS_MESSAGE);
  const since = instantParam(ctx.url, 'since');
  if (since instanceof Response) return since;
  const cursor = ctx.url.searchParams.get('cursor');
  if (cursor !== null && decodeProjectCursor(cursor) === null) return badRequest(PROJECT_CURSOR_REFUSAL);
  const [page, totals] = await Promise.all([
    pagePlansAcross(env.db, set, {
      ...(status === null ? {} : { status }),
      ...(since === undefined ? {} : { since }),
      limit: clampLimit(ctx.url.searchParams.get('limit')),
      ...(cursor === null ? {} : { cursor }),
    }),
    cursor === null && since === undefined ? planTotals(env.db, set) : Promise.resolve(undefined),
  ]);
  return ok({
    plans: page.rows, cursor: page.cursor, hasMore: page.cursor !== null, maxPage: MAX_PAGE,
    ...(totals === undefined ? {} : totals.state === 'ready' ? { totals: totals.value } : { counting: 'building' }),
  });
}
