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
import { listProjectPlans, PLAN_STATUS_MESSAGE, WRITABLE_PLAN_STATUSES } from '../read/plans.js';
import { MAX_PAGE } from './intelligence.js';

const clampLimit = (raw: string | null): number => {
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_PAGE) : 50;
};

/**
 * Every plan this Project holds, newest edit first, optionally one status.
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

  const plans = await listProjectPlans(env.db, scope, {
    ...(status === null ? {} : { status }),
    limit: clampLimit(ctx.url.searchParams.get('limit')),
  });
  return ok({ plans, maxPage: MAX_PAGE });
}
