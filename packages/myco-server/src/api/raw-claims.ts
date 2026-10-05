import type { CredentialContext, OwnerContext } from '../context.js';
import type { ServerEnv } from '../core/adapters.js';
import { RawClaimRefusal, bootstrapOwnership, claimUnknownRaw, ownershipPreview, rawClaimPreview } from '../core/raw-claims.js';

type ActorContext = Pick<CredentialContext, 'memberId' | 'body' | 'now'>;
async function answer<T>(operation: () => Promise<T>): Promise<Response> {
  try { return Response.json(await operation(), { headers: { 'cache-control': 'private, no-store' } }); }
  catch (error) {
    if (!(error instanceof RawClaimRefusal)) throw error;
    const status = error.code === 'not_owner' || error.code === 'not_admin' ? 403 : 409;
    return Response.json({ error: error.code }, { status });
  }
}
function mutation(body: string): { revision: string; ownerMemberId?: string } | null {
  try {
    const value: unknown = JSON.parse(body);
    if (value === null || typeof value !== 'object' || !('revision' in value) || typeof value.revision !== 'string' || !/^\d+$/.test(value.revision)) return null;
    if ('ownerMemberId' in value && typeof value.ownerMemberId !== 'string') return null;
    return value as { revision: string; ownerMemberId?: string };
  } catch { return null; }
}
async function memberAnswer(operation: () => Promise<Response>): Promise<Response> {
  const response = await operation();
  const value = await response.json() as Record<string, unknown>;
  return response.ok
    ? Response.json({ persisted: true, ...value }, { headers: response.headers })
    : Response.json({ persisted: false, code: value.error, reason: value.error }, { headers: response.headers });
}
const badBody = (): Response => Response.json({ error: 'invalid_body' }, { status: 400 });
export const handleMemberRawClaimPreview = (env: ServerEnv, ctx: CredentialContext): Promise<Response> => memberAnswer(() => answer(() => rawClaimPreview(env.db, ctx.memberId)));
async function rawClaim(env: ServerEnv, ctx: ActorContext): Promise<Response> {
  const value = mutation(ctx.body);
  return value === null ? badBody() : answer(() => claimUnknownRaw(env.db, ctx.memberId, value.revision, ctx.now));
}
export const handleRawClaimPreview = (env: ServerEnv, ctx: OwnerContext): Promise<Response> => answer(() => rawClaimPreview(env.db, ctx.member.id));
export async function handleRawClaim(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return rawClaim(env, { memberId: ctx.member.id, body: await ctx.request.text(), now: ctx.now });
}
export const handleMemberOwnershipPreview = (env: ServerEnv, _ctx: CredentialContext): Promise<Response> => memberAnswer(() => answer(() => ownershipPreview(env.db)));
async function ownership(env: ServerEnv, ctx: ActorContext): Promise<Response> {
  const value = mutation(ctx.body);
  return value?.ownerMemberId === undefined ? badBody() : answer(() => bootstrapOwnership(env.db, ctx.memberId, value.ownerMemberId!, value.revision, ctx.now));
}
export const handleOwnershipPreview = (env: ServerEnv, _ctx: OwnerContext): Promise<Response> => answer(() => ownershipPreview(env.db));
export async function handleOwnership(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return ownership(env, { memberId: ctx.member.id, body: await ctx.request.text(), now: ctx.now });
}

export const handleMemberRawClaim = (env: ServerEnv, ctx: ActorContext): Promise<Response> => memberAnswer(() => rawClaim(env, ctx));
export const handleMemberOwnership = (env: ServerEnv, ctx: ActorContext): Promise<Response> => memberAnswer(() => ownership(env, ctx));
