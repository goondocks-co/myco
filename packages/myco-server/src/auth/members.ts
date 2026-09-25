import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
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

/**
 * `POST /members/link-github`: the presented credential asks for a one-time key
 * that links a GitHub account to its member. Answered once; the key is never
 * shown again and only its digest is stored.
 */
export const handleLinkGithub = emptyBodyRoute(async (env: ServerEnv, ctx: RouteContext) => {
  const issued = await issueIdentityLinkAuthority(env.db, ctx.memberId, ctx.now);
  return Response.json({ persisted: true, key: issued.key, expiresAt: issued.expiresAt });
});
