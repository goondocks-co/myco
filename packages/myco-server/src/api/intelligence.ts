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
import { countSpores, getSpore, listSupersededSporeIds, listSupersedingSporeIds, pageSpores } from '../core/spores.js';
import { canonicalNamespace, listReleaseStates } from '../core/provenance.js';
import { decodeCursor } from '../read/scope.js';

/** The largest page this surface serves, whatever a caller asks for. */
export const MAX_PAGE = 200;

const clampLimit = (raw: string | null): number => {
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_PAGE) : 50;
};

/** Where a page starts; anything that is not a whole count of rows starts at the first. */
const offsetOf = (raw: string | null): number => {
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/** Resolve the Project or answer 404. A Project the caller does not hold is indistinguishable from one that does not exist. */
async function scopeOf(env: ServerEnv, ctx: OwnerContext) {
  const projectId = ctx.params.projectId;
  return projectId === undefined ? null : await resolveProjectScope(env.db, ctx.member, projectId);
}

/**
 * A Project's spores, newest first, paged by offset or by `cursor`, the keyset the previous page answered; the two do not
 * combine. Every page carries `cursor`, null when no spore follows it. A start instant (inclusive) and an end instant
 * (exclusive) bound when they were written, and `author` names who wrote them, as a run's id. `total` counts what the
 * filters match when the page is read.
 */
export async function handleProjectSpores(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await scopeOf(env, ctx);
  if (scope === null) return notFound();
  const since = instantParam(ctx.url, 'since');
  if (since instanceof Response) return since;
  const until = instantParam(ctx.url, 'until');
  if (until instanceof Response) return until;
  const cursor = ctx.url.searchParams.get('cursor') ?? undefined;
  if (cursor !== undefined && decodeCursor(cursor) === null) return badRequest('malformed cursor');
  if (cursor !== undefined && ctx.url.searchParams.has('offset')) return badRequest('cursor and offset do not combine');
  const options = {
    observationType: ctx.url.searchParams.get('type') ?? undefined,
    status: ctx.url.searchParams.get('status') ?? undefined,
    sessionId: ctx.url.searchParams.get('session') ?? undefined,
    author: ctx.url.searchParams.get('author') ?? undefined,
    search: ctx.url.searchParams.get('q') ?? undefined,
    createdFrom: since,
    createdTo: until,
    limit: clampLimit(ctx.url.searchParams.get('limit')),
    offset: offsetOf(ctx.url.searchParams.get('offset')),
  };
  const [paged, total] = await Promise.all([
    pageSpores(env.db, scope, { ...options, cursor }),
    countSpores(env.db, scope, options),
  ]);
  return paged === null ? badRequest('malformed cursor') : ok({ spores: paged.rows, cursor: paged.cursor, total, maxPage: MAX_PAGE });
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
