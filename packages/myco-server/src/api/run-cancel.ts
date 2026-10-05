import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { isAdmin } from '../auth/roles.js';
import { cancelRun } from '../core/runs.js';
import { releaseRun } from '../core/release.js';
import { notFound, ok, resolveProjectScope } from './scope.js';

/** Stop a live run in a Project the Deployment serves. */
export async function handleCancelRun(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const runId = ctx.params.runId;
  if (runId === undefined) return notFound();
  const cancelled = await cancelRun(env.db, scope, runId,
    { memberId: ctx.member.id, admin: isAdmin(ctx.member.role) }, ctx.now);
  if (cancelled === null) return notFound();
  await releaseRun(env, scope, { id: runId, dispatchedBy: cancelled.displaced }, ctx.now);
  return ok({ cancelled: true, runId });
}
