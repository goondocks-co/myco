import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { issueMemberToken, revokeProjectMemberToken } from '../auth/tokens.js';
import { listTokens, tokenActivity } from '../read/tokens.js';
import { badRequest, notFound, ok, resolveProjectScope } from './scope.js';
import { paging } from './sessions.js';

/** The machine identity a minted token carries. Bounded and in grammar, so the owner API cannot mint a credential whose identity the ingest path would refuse. */
const MACHINE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** A project's tokens. `token_hash` is never selected by the read, so there is nothing here to redact. */
export async function handleTokens(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  return ok({ tokens: await listTokens(env.db, scope) });
}

/** Mint a member token for a project. The plaintext is returned once and never stored — only its digest is. */
export async function handleMintToken(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  let body: { machineId?: unknown };
  try {
    body = (await ctx.request.json()) as { machineId?: unknown };
  } catch {
    return badRequest('body must be JSON');
  }
  const machineId = body.machineId;
  if (typeof machineId !== 'string' || !MACHINE_ID.test(machineId)) return badRequest('machineId must match the machine-id grammar');
  const issued = await issueMemberToken(env.db, { projectId: scope.projectId, machineId }, ctx.now);
  return Response.json({ id: issued.tokenId, token: issued.token, expiresAt: issued.expiresAt }, { status: 201 });
}

export async function handleRevokeToken(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  return ok(await revokeProjectMemberToken(env.db, scope.projectId, ctx.params.tokenId, ctx.now));
}

/** What one token wrote. The scope comes from the path, never from a query parameter the caller supplies. */
export async function handleTokenActivity(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  return ok(await tokenActivity(env.db, scope, ctx.params.tokenId, page));
}
