import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { OWNER_ACTOR_PREFIX } from '../constants.js';
import { ensureMember } from '../auth/enrollment.js';
import { issueMemberToken, revokeCredentialAsMember } from '../auth/tokens.js';
import { listTokens, tokenActivity } from '../read/tokens.js';
import { badRequest, notFound, ok, resolveProjectScope } from './scope.js';
import { paging } from './sessions.js';

/** The machine identity a minted token carries. Bounded and in grammar, so the owner API cannot mint a credential whose identity the ingest path would refuse. */
const MACHINE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The Deployment's credentials. `token_hash` is never selected by the read, so there is nothing here to redact. The path still carries a project segment, which the dashboard re-scope in #918 removes. */
export async function handleTokens(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  return ok({ tokens: await listTokens(env.db, scope) });
}

/** Mint a credential for a member. The plaintext is returned once and never stored — only its digest is. A credential is Deployment-wide, so the caller names the member rather than a project. */
export async function handleMintToken(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  let body: { machineId?: unknown; memberId?: unknown };
  try {
    body = (await ctx.request.json()) as { machineId?: unknown; memberId?: unknown };
  } catch {
    return badRequest('body must be JSON');
  }
  const machineId = body.machineId;
  if (typeof machineId !== 'string' || !MACHINE_ID.test(machineId)) return badRequest('machineId must match the machine-id grammar');
  const memberId = typeof body.memberId === 'string' && MACHINE_ID.test(body.memberId) ? body.memberId : `mem_${machineId}`;
  await ensureMember(env.db, memberId, ctx.now);
  const issued = await issueMemberToken(env.db, { memberId, machineId }, ctx.now);
  return Response.json({ id: issued.tokenId, token: issued.token, expiresAt: issued.expiresAt }, { status: 201 });
}

export async function handleRevokeToken(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  // The owner acts through the dashboard, not as a member, and `revoked_by` must say
  // which: member ids carry `mem_`, so an unprefixed GitHub id in the same column is
  // indistinguishable from one — exactly the ambiguity the column exists to remove.
  return ok(await revokeCredentialAsMember(env.db, `${OWNER_ACTOR_PREFIX}${ctx.session.sub}`, ctx.params.tokenId, ctx.now));
}

/** What one token wrote. The scope comes from the path, never from a query parameter the caller supplies. */
export async function handleTokenActivity(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  return ok(await tokenActivity(env.db, scope, ctx.params.tokenId, page));
}
