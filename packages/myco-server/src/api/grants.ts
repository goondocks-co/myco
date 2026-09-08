import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import {
  GRANT_LABEL_MAX, GRANT_LABEL_PATTERN, GRANT_TTL_DAYS_DEFAULT, GRANT_TTL_DAYS_MAX, GRANT_TTL_DAYS_MIN,
  issueExternalGrant, listExternalGrants, revokeExternalGrant, rotateExternalGrant,
} from '../auth/grants.js';
import { badRequest, notFound, ok, readJsonObject, resolveProjectScope } from './scope.js';

/** Every grant of the Project, live and revoked. Never a key. */
export async function handleGrants(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  return ok({ grants: await listExternalGrants(env.db, scope) });
}

/**
 * `POST /api/projects/{projectId}/grants {label?, expires_in_days?}`: a grant
 * for this Project. The key is answered once.
 *
 * A grant always ends: naming no window takes the default rather than living
 * forever, and a named window is held to the same bounds a person can read off
 * the refusal.
 */
export async function handleMintGrant(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  let label: string | null = null;
  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || !GRANT_LABEL_PATTERN.test(body.label)) return badRequest(`label must be 1 to ${GRANT_LABEL_MAX} printable characters`);
    label = body.label;
  }
  let ttlDays = GRANT_TTL_DAYS_DEFAULT;
  if (body.expires_in_days !== undefined) {
    const named = body.expires_in_days;
    if (typeof named !== 'number' || !Number.isSafeInteger(named) || named < GRANT_TTL_DAYS_MIN || named > GRANT_TTL_DAYS_MAX) {
      return badRequest(`expires_in_days must be a whole number of days from ${GRANT_TTL_DAYS_MIN} to ${GRANT_TTL_DAYS_MAX}`);
    }
    ttlDays = named;
  }
  const issued = await issueExternalGrant(env.db, scope, label, ctx.member.id, ctx.now, ttlDays);
  return Response.json({ key: issued.key, id: issued.id, expiresAt: issued.expiresAt }, { status: 201 });
}

/** Issues a successor and ends the predecessor in one step; the new key is answered once, and keeps the predecessor's window. */
export async function handleRotateGrant(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const issued = await rotateExternalGrant(env.db, scope, ctx.params.grantId, ctx.member.id, ctx.now);
  if (issued === null) return notFound();
  return Response.json({ key: issued.key, id: issued.id, expiresAt: issued.expiresAt, rotatedFrom: ctx.params.grantId }, { status: 201 });
}

export async function handleRevokeGrant(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const result = await revokeExternalGrant(env.db, scope, ctx.params.grantId, ctx.member.id, ctx.now);
  return ok({ revoked: result.revoked, revokedBy: ctx.member.id });
}
