import { AUTH_SETUP_CODES } from '@goondocks/myco-shared/member-protocol';
import { isDeploymentOwner } from '../core/raw-claims.js';
import type { ServerEnv } from '../core/adapters.js';
import type { SessionContext } from '../context.js';
import { accountMembership, hasLinkedAdmin, IDENTITY_LINK_KEY_PATTERN, previewIdentityLinkAuthority, spendIdentityLinkAuthority, type IdentityLinkRefusal } from '../auth/identity-link.js';
import { badRequest, ok, readJsonObject } from './scope.js';
import { nameMemberFromLogin } from '../auth/members-admin.js';
import { deploymentIdentity, memberSubject } from '../auth/authorization.js';
import { dashboardPermissions } from '../auth/dashboard-permissions.js';

/**
 * `GET /auth/me`: the signed-in account, and the member it is linked to, or null. The one read that tells "signed in"
 * from "a member". A linked member with no name yet takes the account's GitHub login as its name here, the first read
 * a sign-in makes.
 */
export async function handleMe(env: ServerEnv, ctx: SessionContext): Promise<Response> {
  let member = ctx.member;
  if (member !== null) {
    // Naming is a courtesy of the sign-in, never a condition of it: a write that fails leaves the member as it was.
    try {
      const named = await nameMemberFromLogin(env.db, member.id, ctx.session.sub, ctx.session.login);
      if (named !== null) member = { ...member, label: named };
    } catch {
      member = ctx.member;
    }
  }
  const subject = member === null
    ? { kind: 'account' as const, deploymentId: await deploymentIdentity(env.db), transport: 'http' as const, live: true }
    : await memberSubject(env.db, member.id, 'http');
  const membership = await accountMembership(env.db, ctx.session.sub);
  return ok({ sub: ctx.session.sub, login: ctx.session.login, member, membership, owner: member !== null && await isDeploymentOwner(env.db, member.id), permissions: dashboardPermissions(subject) });
}

const STATUS: Record<IdentityLinkRefusal, number> = { denied: 400, identity_taken: 409, member_linked: 409, member_revoked: 403, link_requires_admin: 403 };
const CODE: Record<IdentityLinkRefusal, string> = { denied: 'link_denied', identity_taken: 'identity_taken', member_linked: 'member_linked', member_revoked: 'member_revoked', link_requires_admin: 'link_requires_admin' };

/**
 * `POST /auth/link {key[, confirm]}`: without `confirm`, the member a live key
 * names, so the page can show whom the account is about to be connected to;
 * with `confirm: true`, the spend that binds the signed-in account to that
 * member. The account is the session's, never the body's.
 */
export async function handleLink(env: ServerEnv, ctx: SessionContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  if (typeof body.key !== 'string' || !IDENTITY_LINK_KEY_PATTERN.test(body.key)) return badRequest('key must be a link key');
  if (body.confirm !== true) {
    const preview = await previewIdentityLinkAuthority(env.db, body.key, ctx.now);
    return preview.ok ? ok({ preview: { member: preview.member } }) : linkRefusal(env, preview.reason);
  }
  const result = await spendIdentityLinkAuthority(env.db, body.key, ctx.session.sub, ctx.now);
  if (result.ok) {
    // Record the linked GitHub login and fill an unnamed member's display name.
    const named = await nameMemberFromLogin(env.db, result.member.id, ctx.session.sub, ctx.session.login);
    return ok({ linked: true, member: named === null ? result.member : { ...result.member, label: named } });
  }
  return linkRefusal(env, result.reason);
}

async function linkRefusal(env: ServerEnv, reason: IdentityLinkRefusal): Promise<Response> {
  const code = reason === 'denied' && !await hasLinkedAdmin(env.db) ? AUTH_SETUP_CODES.ownerLinkDenied : CODE[reason];
  return Response.json({ error: code }, { status: STATUS[reason] });
}
