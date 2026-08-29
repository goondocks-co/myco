import type { ServerEnv } from '../core/adapters.js';
import type { SessionContext } from '../context.js';
import { IDENTITY_LINK_KEY_PATTERN, previewIdentityLinkAuthority, spendIdentityLinkAuthority, type IdentityLinkRefusal } from '../auth/identity-link.js';
import { badRequest, ok, readJsonObject } from './scope.js';

/** `GET /auth/me`: the signed-in account, and the member it is linked to, or null. The one read that tells "signed in" from "a member". */
export async function handleMe(_env: ServerEnv, ctx: SessionContext): Promise<Response> {
  return ok({ sub: ctx.session.sub, login: ctx.session.login, member: ctx.member });
}

const STATUS: Record<IdentityLinkRefusal, number> = { denied: 400, identity_taken: 409, member_linked: 409, member_revoked: 403 };
const CODE: Record<IdentityLinkRefusal, string> = { denied: 'link_denied', identity_taken: 'identity_taken', member_linked: 'member_linked', member_revoked: 'member_revoked' };

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
    const member = await previewIdentityLinkAuthority(env.db, body.key, ctx.now);
    return member === null ? Response.json({ error: CODE.denied }, { status: STATUS.denied }) : ok({ preview: { member } });
  }
  const result = await spendIdentityLinkAuthority(env.db, body.key, ctx.session.sub, ctx.now);
  if (result.ok) return ok({ linked: true, member: result.member });
  return Response.json({ error: CODE[result.reason] }, { status: STATUS[result.reason] });
}
