import type { ServerEnv } from '../core/adapters.js';
import type { SessionContext } from '../context.js';
import { IDENTITY_LINK_KEY_PATTERN, previewIdentityLinkAuthority, spendIdentityLinkAuthority, type IdentityLinkRefusal } from '../auth/identity-link.js';
import { badRequest, ok, readJsonObject } from './scope.js';
import { nameMemberFromLogin } from '../auth/members-admin.js';

/**
 * `GET /auth/me`: the signed-in account, and the member it is linked to, or null. The one read that tells "signed in"
 * from "a member". A linked member with no name yet takes the account's GitHub login as its name here, the first read
 * a sign-in makes.
 */
export async function handleMe(env: ServerEnv, ctx: SessionContext): Promise<Response> {
  let member = ctx.member;
  if (member !== null && member.label === null) {
    // Naming is a courtesy of the sign-in, never a condition of it: a write that fails leaves the member as it was.
    try {
      const named = await nameMemberFromLogin(env.db, member.id, ctx.session.login);
      if (named !== null) member = { ...member, label: named };
    } catch {
      member = ctx.member;
    }
  }
  return ok({ sub: ctx.session.sub, login: ctx.session.login, member });
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
    return preview.ok ? ok({ preview: { member: preview.member } }) : Response.json({ error: CODE[preview.reason] }, { status: STATUS[preview.reason] });
  }
  const result = await spendIdentityLinkAuthority(env.db, body.key, ctx.session.sub, ctx.now);
  if (result.ok) {
    // The account linked names a member that has no name yet.
    const named = result.member.label === null ? await nameMemberFromLogin(env.db, result.member.id, ctx.session.login) : null;
    return ok({ linked: true, member: named === null ? result.member : { ...result.member, label: named } });
  }
  return Response.json({ error: CODE[result.reason] }, { status: STATUS[result.reason] });
}
