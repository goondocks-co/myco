/**
 * The generated intelligence, read through the product surface.
 *
 * The member routes under `/spores` and `/runs` serve the harness that produces
 * this; these serve the people who read it. Same rows, different callers, and
 * the distinction matters: a harness writes on behalf of one Project it was
 * dispatched for, while an owner browses across Projects they hold.
 *
 * **An empty answer is not a missing one.** Every collection here answers `200`
 * with an empty list for a Project that has generated nothing yet, and `404`
 * only when the Project itself is not one this caller may see. A surface that
 * conflated them would make "the task has not run" indistinguishable from "the
 * task does not exist", which is exactly the report an operator needs when
 * intelligence stops appearing.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { badRequest, instantParam, notFound, ok, resolveProjectScope } from './scope.js';
import { getSpore, listSporePage, listSupersededSporeIds, listSupersedingSporeIds, sporeListWindow } from '../core/spores.js';
import { searchRepairRefusal } from '../core/search-repair.js';
import { canonicalNamespace, listReleaseStates } from '../core/provenance.js';
import { decodeCursor } from '../read/scope.js';

/** The largest page this surface serves, whatever a caller asks for. */
export const MAX_PAGE = 200;

const clampLimit = (raw: string | null): number => {
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_PAGE) : 50;
};

/** The refusal of offset paging, retired for keyset cursors. */
export const OFFSET_REFUSAL = 'offset paging is retired, and nothing was read: send the cursor the previous page answered as cursor.';

/** Resolve the Project or answer 404. A Project the caller does not hold is indistinguishable from one that does not exist. */
async function scopeOf(env: ServerEnv, ctx: OwnerContext) {
  const projectId = ctx.params.projectId;
  return projectId === undefined ? null : await resolveProjectScope(env.db, ctx.member, projectId);
}

/**
 * A Project's spores, newest first, a page at a time by `cursor`, the keyset the previous page answered. A start instant
 * (inclusive) and an end instant (exclusive) bound when they were written, widened to whole UTC days (the answer's
 * `window`), and `author` names who wrote them, as a run's id. `hasMore` says whether another page follows. `total` is
 * read from the maintained counters, replaced by `counting: 'building'` while existing spores are still being counted;
 * a list by author has no total.
 */
export async function handleProjectSpores(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await scopeOf(env, ctx);
  if (scope === null) return notFound();
  if (ctx.url.searchParams.has('offset')) return badRequest(OFFSET_REFUSAL);
  const since = instantParam(ctx.url, 'since');
  if (since instanceof Response) return since;
  const until = instantParam(ctx.url, 'until');
  if (until instanceof Response) return until;
  const q = ctx.url.searchParams.get('q');
  if (q !== null) {
    const param = (name: string) => ctx.url.searchParams.get(name) ?? undefined;
    return badRequest(searchRepairRefusal('q', { type: 'spore', text: q, projects: [scope.projectId], status: param('status'), observationType: param('type'),
      sessionId: param('session'), ...sporeListWindow({ createdFrom: since, createdTo: until }), unsupported: param('author') === undefined ? [] : ['author'] }));
  }
  const cursor = ctx.url.searchParams.get('cursor') ?? undefined;
  if (cursor !== undefined && decodeCursor(cursor) === null) return badRequest('malformed cursor');
  const listed = await listSporePage(env.db, scope, {
    observationType: ctx.url.searchParams.get('type') ?? undefined,
    status: ctx.url.searchParams.get('status') ?? undefined,
    sessionId: ctx.url.searchParams.get('session') ?? undefined,
    author: ctx.url.searchParams.get('author') ?? undefined,
    createdFrom: since,
    createdTo: until,
    limit: clampLimit(ctx.url.searchParams.get('limit')),
    cursor,
  });
  if (listed === null) return badRequest('malformed cursor');
  const { rows, ...page } = listed;
  return ok({ spores: rows, ...page, maxPage: MAX_PAGE });
}

/** One spore and its lineage in both directions, so a reader sees a retired spore's replacement rather than a dead end, and a replacement what it grew out of. */
export async function handleProjectSpore(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await scopeOf(env, ctx);
  if (scope === null) return notFound();
  const spore = await getSpore(env.db, scope, ctx.params.sporeId ?? '');
  if (spore === null) return notFound();
  const [supersededBy, supersedes] = await Promise.all([
    listSupersedingSporeIds(env.db, scope, spore.id),
    listSupersededSporeIds(env.db, scope, spore.id),
  ]);
  return ok({ spore, supersededBy, supersedes });
}

export async function handleProjectReleaseStates(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await scopeOf(env, ctx);
  if (scope === null) return notFound();
  const named = ctx.url.searchParams.get('namespace');
  const namespace = named === null ? undefined : canonicalNamespace(named);
  // A namespace no record carries names no release state.
  if (namespace === null) return ok({ releaseStates: [] });
  return ok({
    releaseStates: await listReleaseStates(env.db, scope, {
      namespace,
      state: ctx.url.searchParams.get('state') ?? undefined,
      limit: clampLimit(ctx.url.searchParams.get('limit')),
    }),
  });
}
