import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { GRANT_LABEL_PATTERN, issueExternalGrant, listExternalGrants, revokeExternalGrant, rotateExternalGrant } from '../auth/grants.js';
import { badRequest, notFound, ok, resolveProjectScope } from './scope.js';

/** Every grant of the Project, live and revoked. Never a key. */
export async function handleGrants(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  return ok({ grants: await listExternalGrants(env.db, scope) });
}

/** `POST /api/projects/{projectId}/grants {label?}`: a read-only grant for this Project. The key is answered once. */
export async function handleMintGrant(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  let body: { label?: unknown };
  try {
    body = (await ctx.request.json()) as { label?: unknown };
  } catch {
    return badRequest('body must be JSON');
  }
  let label: string | null = null;
  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || !GRANT_LABEL_PATTERN.test(body.label)) return badRequest('label must be 1 to 80 printable characters');
    label = body.label;
  }
  const issued = await issueExternalGrant(env.db, scope, label, ctx.member.id, ctx.now);
  return Response.json({ key: issued.key, id: issued.id }, { status: 201 });
}

/** Issues a successor and ends the predecessor in one step; the new key is answered once. */
export async function handleRotateGrant(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const issued = await rotateExternalGrant(env.db, scope, ctx.params.grantId, ctx.member.id, ctx.now);
  if (issued === null) return notFound();
  return Response.json({ key: issued.key, id: issued.id, rotatedFrom: ctx.params.grantId }, { status: 201 });
}

export async function handleRevokeGrant(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const result = await revokeExternalGrant(env.db, scope, ctx.params.grantId, ctx.member.id, ctx.now);
  return ok({ revoked: result.revoked, revokedBy: ctx.member.id });
}
