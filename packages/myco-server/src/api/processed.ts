import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { isProcessedBodyKind, processedBody } from '../read/processed.js';
import { notFound, resolveProjectScope } from './scope.js';

/** A typed projected field, served as inert text with current Project admission. */
export async function handleProcessedBody(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const kind = ctx.params.kind;
  if (!isProcessedBodyKind(kind)) return notFound();
  let id: string;
  try { id = decodeURIComponent(ctx.params.id); } catch { return notFound(); }
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const body = await processedBody(env, scope, kind, id);
  if (body === null) return notFound();
  return new Response(body, { headers: {
    'content-type': 'text/plain; charset=utf-8',
    'content-security-policy': "default-src 'none'; sandbox",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  } });
}
