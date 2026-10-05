import type { CredentialContext, OwnerContext } from '../context.js';
import type { ServerEnv } from '../core/adapters.js';
import { changeMemberRole, OwnershipRefusal, transferOwnership } from '../core/ownership.js';
import { MEMBER_ID } from '../constants.js';
import { asMemberRole } from '../auth/roles.js';
import { listMembers } from '../auth/members-admin.js';
import { parseJsonObject } from './scope.js';

type ActorContext = Pick<CredentialContext, 'memberId' | 'body' | 'now'>;
type Operation = (env: ServerEnv, actor: string, body: Record<string, unknown>, now: number) => Promise<unknown>;
const revision = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));

/** Both transports admit the same mutation and differ only in their refusal envelope. */
function mutation(operation: Operation) {
  async function answer(env: ServerEnv, ctx: ActorContext, member: boolean): Promise<Response> {
    const body = parseJsonObject(ctx.body);
    try {
      if (body === null || typeof body.member_id !== 'string' || !MEMBER_ID.test(body.member_id) || !revision(body.expected_revision)) {
        return member ? Response.json({ persisted: false, code: 'invalid_body', reason: 'invalid_body' }) : Response.json({ error: 'invalid_body' }, { status: 400 });
      }
      const result = await operation(env, ctx.memberId, body, ctx.now);
      return Response.json(member ? { persisted: true, ...result as object } : result, { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      if (!(error instanceof OwnershipRefusal)) throw error;
      return member ? Response.json({ persisted: false, code: error.code, reason: error.code })
        : Response.json({ error: error.code }, { status: error.code === 'not_owner' ? 403 : 409 });
    }
  }
  return {
    member: (env: ServerEnv, ctx: ActorContext) => answer(env, ctx, true),
    dashboardBody: (env: ServerEnv, ctx: ActorContext) => answer(env, ctx, false),
    dashboard: async (env: ServerEnv, ctx: OwnerContext) => answer(env, { memberId: ctx.member.id, body: await ctx.request.text(), now: ctx.now }, false),
  };
}

const transfer = mutation((env, actor, body, now) => transferOwnership(env.db, actor, body.member_id as string, body.expected_revision as string, now));
const role = mutation((env, actor, body, now) => {
  const desired = asMemberRole(body.role);
  if (desired === null) throw new OwnershipRefusal('invalid_member');
  return changeMemberRole(env.db, actor, body.member_id as string, desired, body.expected_revision as string, now);
});
export const handleOwnershipTransfer = transfer.dashboard;
export const handleMemberOwnershipTransfer = transfer.member;
export async function handleMemberRole(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = parseJsonObject(await ctx.request.text());
  if (body?.member_id !== undefined && body.member_id !== ctx.params.memberId) return Response.json({ error: 'invalid_body' }, { status: 400 });
  return role.dashboardBody(env, { memberId: ctx.member.id, now: ctx.now, body: JSON.stringify({ ...body, member_id: ctx.params.memberId }) });
}
export const handleCredentialMemberRole = role.member;

export async function handleCredentialRoles(env: ServerEnv, ctx: CredentialContext): Promise<Response> {
  return Response.json({ persisted: true, members: await listMembers(env.db, ctx.now) }, { headers: { 'cache-control': 'private, no-store' } });
}
