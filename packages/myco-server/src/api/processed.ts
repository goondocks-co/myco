import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { isProcessedBodyKind, processedAttachment, processedBody } from '../read/processed.js';
import { bundleContentEnv } from '../core/archive-bundle.js';
import { notFound, resolveProjectScope, sessionInScope } from './scope.js';
import { documentBody, isDocumentBodyKind } from '../content/session-pages.js';

const ATTACHMENT_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PROCESSED_SECURITY = {
  'content-security-policy': "default-src 'none'; sandbox",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'cache-control': 'private, no-store',
};

/**
 * A typed projected field or attachment, served with current Project admission. A prompt's or reply's text and a tool's
 * input or output are read from the session's document at the locator the row carried: `session`, `generation`,
 * `owner` and `page`.
 */
export async function handleProcessedBody(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const kind = ctx.params.kind;
  if (!isProcessedBodyKind(kind)) return notFound();
  let id: string;
  try { id = decodeURIComponent(ctx.params.id); } catch { return notFound(); }
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  if (kind === 'attachment') {
    const attachment = await processedAttachment(env, scope, id);
    if (attachment === null) return notFound();
    const image = ATTACHMENT_IMAGES.has(attachment.mediaType);
    return new Response(attachment.body, { headers: {
      ...PROCESSED_SECURITY,
      'content-type': image ? attachment.mediaType : 'application/octet-stream',
      'content-length': String(attachment.size),
      ...(image ? {} : { 'content-disposition': `attachment; filename="${encodeURIComponent(id)}"` }),
    } });
  }
  if (isDocumentBodyKind(kind)) {
    const search = ctx.url.searchParams;
    const sessionId = search.get('session'), owner = search.get('owner');
    const generation = Number(search.get('generation')), page = Number(search.get('page'));
    if (sessionId === null || owner === null || !Number.isSafeInteger(generation) || !Number.isSafeInteger(page)) return notFound();
    if (!(await sessionInScope(env.db, scope, sessionId))) return notFound();
    const text = await documentBody(env, scope.projectId, sessionId, kind, id, { generation, owner, page });
    if (text === 'stale') return Response.json({ error: 'stale_cursor' }, { status: 409 });
    if (text === null) return notFound();
    return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', ...PROCESSED_SECURITY } });
  }
  const body = await processedBody(bundleContentEnv(env), scope, kind, id);
  if (body === null) return notFound();
  return new Response(body, { headers: {
    'content-type': 'text/plain; charset=utf-8',
    ...PROCESSED_SECURITY,
  } });
}
