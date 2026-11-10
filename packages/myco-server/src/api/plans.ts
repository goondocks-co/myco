/**
 * A Project's plans, read across its sessions.
 *
 * The session surface already serves a session's own plans, and the MCP tool
 * serves the ones a runtime asks for. This serves the reader who wants the
 * Project's plans as one list: what is in progress, what someone abandoned, and what
 * a session produced weeks ago.
 *
 * All three callers read through `read/plans.ts`, so a plan's progress, its tags
 * and its administrative stamp are derived in one place. The status write is NOT
 * here: a plan's status is set through the session route that already owns it, so
 * there is one write path for a plan's status and this surface stays a read.
 *
 * An empty list is an answer. A Project that has produced no plan answers 200 with
 * none, and 404 names only a Project this caller may not see.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { notFound, ok, resolveProjectScope } from './scope.js';
import {
  plans_getPlan as getPlan,
  plans_pageProjectPlans as pageProjectPlans,
  plans_PLAN_STATUS_MESSAGE as PLAN_STATUS_MESSAGE,
  plans_WRITABLE_PLAN_STATUSES as WRITABLE_PLAN_STATUSES,
} from '../read/catalog/plans.js';
import { MAX_PAGE } from './intelligence.js';

/** The refusal of a cursor this list did not issue. */
const PROJECT_PLAN_CURSOR_REFUSAL = 'malformed cursor: this list pages by "<instant>:<planKey>" exactly as its last answer returned it in `cursor`. '
  + 'Nothing was read: request the first page again with the same status and no cursor.';

const clampLimit = (raw: string | null): number => {
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_PAGE) : 50;
};

/**
 * The plans this Project holds, newest edit first, a page at a time (`cursor` names the next, `hasMore` says one
 * follows), optionally one status. Each row is the plan's metadata, a preview and its progress; the body is read from
 * the plan's own route.
 *
 * A status outside the catalogue is refused rather than answered empty: a filter
 * nothing matches and a filter nothing could match read the same on a page, and
 * only one of them is the caller's mistake.
 */
export async function handleProjectPlans(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const projectId = ctx.params.projectId;
  const scope = projectId === undefined ? null : await resolveProjectScope(env.db, ctx.member, projectId);
  if (scope === null) return notFound();

  const status = ctx.url.searchParams.get('status');
  if (status !== null && !WRITABLE_PLAN_STATUSES.has(status)) return Response.json({ error: 'bad_request', reason: PLAN_STATUS_MESSAGE }, { status: 400 });

  const cursor = ctx.url.searchParams.get('cursor');
  const page = await pageProjectPlans(env.db, scope, {
    ...(status === null ? {} : { status }),
    limit: clampLimit(ctx.url.searchParams.get('limit')),
    ...(cursor === null ? {} : { cursor }),
  });
  if (page === null) return Response.json({ error: 'bad_request', reason: PROJECT_PLAN_CURSOR_REFUSAL }, { status: 400 });
  return ok({ plans: page.rows, cursor: page.cursor, hasMore: page.cursor !== null, maxPage: MAX_PAGE });
}

/** `GET /api/projects/{projectId}/plans/{planKey}`: one plan with its tags. A plan under another Project answers 404, as one that never existed. */
export async function handleProjectPlan(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId ?? '');
  if (scope === null) return notFound();
  const plan = await getPlan(env.db, scope, ctx.params.planKey ?? '');
  return plan === null ? notFound() : ok({ plan, projectId: scope.projectId });
}
