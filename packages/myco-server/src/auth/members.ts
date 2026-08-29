import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { refusal, type Refusal } from '../telemetry.js';
import { issueIdentityLinkAuthority } from './identity-link.js';

/** The link body: an empty JSON object. A body that is not JSON, not an object, or carries a field is refused by name. */
function parseLinkBody(body: string): Refusal | null {
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

/**
 * `POST /members/link-github`: the presented credential asks for a one-time key
 * that links a GitHub account to its member. Answered once; the key is never
 * shown again and only its digest is stored.
 */
export async function handleLinkGithub(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const malformed = parseLinkBody(ctx.body);
  if (malformed !== null) return Response.json({ persisted: false, code: malformed.classifier, reason: malformed.reason });
  const issued = await issueIdentityLinkAuthority(env.db, ctx.memberId, ctx.now);
  return Response.json({ persisted: true, key: issued.key, expiresAt: issued.expiresAt });
}
