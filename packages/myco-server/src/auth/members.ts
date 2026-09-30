import type { ServerEnv } from '../core/adapters.js';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import type { RouteContext } from '../context.js';
import { refused } from '../ingest/events.js';
import { refusal, type Refusal } from '../telemetry.js';
import { issueIdentityLinkAuthority } from './identity-link.js';

/** A body that is not JSON, not an object, or carries a field: refused by name, in the `persisted` shape. */
function emptyBodyRefusal(body: string): Refusal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return refusal('body must be JSON', 'parse');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return refusal('body must be an object');
  const [field] = Object.keys(parsed);
  return field === undefined ? null : refusal(`unknown field ${field}`, 'unknown_field');
}

/** A member json route whose body is the empty object: any other body is refused before `handler` runs. */
export const emptyBodyRoute = <C extends Pick<RouteContext, 'body'>>(handler: (env: ServerEnv, ctx: C) => Promise<Response>) =>
  async (env: ServerEnv, ctx: C): Promise<Response> => {
    const malformed = emptyBodyRefusal(ctx.body);
    return malformed === null ? handler(env, ctx) : Response.json({ persisted: false, code: malformed.classifier, reason: malformed.reason });
  };

/** What a member credential is told when the Deployment already has a linked admin: its GitHub account is linked by an admin now. */
export const LINK_REQUIRES_ADMIN = `this server already has an admin; ask an admin to link your GitHub account from the dashboard's ${INVITE_CONTROLS.page} page`;

/**
 * `POST /members/link-github`: the presented credential asks for a one-time key
 * that links a GitHub account to its member. Answered only while the Deployment
 * has no live admin with a GitHub account linked — the first sign-in on a fresh
 * Deployment — and refused `link_requires_admin` after, with no key written.
 * Answered once; the key is never shown again and only its digest is stored.
 */
export const handleLinkGithub = emptyBodyRoute(async (env: ServerEnv, ctx: RouteContext) => {
  const issued = await issueIdentityLinkAuthority(env.db, ctx.memberId, ctx.now);
  if (issued === null) return Response.json(refused(ctx, refusal(LINK_REQUIRES_ADMIN, 'link_requires_admin')));
  return Response.json({ persisted: true, key: issued.key, expiresAt: issued.expiresAt });
});
