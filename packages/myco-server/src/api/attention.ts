/**
 * `GET /api/attention`: what an administrator should act on (Today's "Needs you").
 *
 * Admin only, by the route's declared authority: every item is about the Deployment's own operation, which only an
 * administrator can change.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { ok } from './scope.js';
import { readAttention } from '../core/attention.js';

export async function handleAttention(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return ok(await readAttention(env, ctx.now));
}
