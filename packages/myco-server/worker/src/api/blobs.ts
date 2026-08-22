import type { Env } from '../env.js';
import type { OwnerContext } from '../context.js';
import { getBlob } from '../read/blobs.js';
import { notFound, resolveProjectScope } from './scope.js';

/**
 * Media types served with their stored type. Everything else is served as an opaque
 * download.
 *
 * A member token is a write-only machine credential, and `canonicalMediaType`
 * (`ingest/blobs.ts:26`) accepts any well-formed `token/token`, so an uploader chooses the
 * type. Reflecting `text/html` onto the owner origin is script execution under the owner's
 * session on a top-level navigation — the way the transcript and spilled-text links are
 * meant to be followed.
 */
const RENDERABLE = new Set([
  'text/plain; charset=utf-8',
  'application/json',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Headers that hold whether or not the type is renderable: no scripts, no framing, no plugins. */
const BLOB_SECURITY: Record<string, string> = {
  'content-security-policy': "default-src 'none'; sandbox",
  'x-frame-options': 'DENY',
};

/**
 * Blob bytes inside the resolved scope.
 *
 * Blobs are content-addressed and project-prefixed in R2, and the `blobs` row is keyed
 * `(project_id, key)`, so the project is in the path and the row is read before the object.
 */
export async function handleBlobRead(env: Env, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.MYCO_DB, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  const row = await getBlob(env.MYCO_DB, scope, ctx.params.key);
  if (row === null) return notFound();
  const object = await env.BUCKET.get(`${scope.projectId}/${ctx.params.key}`);
  if (object === null) return notFound();
  const renderable = RENDERABLE.has(row.mediaType);
  return new Response(object.body, {
    headers: {
      ...BLOB_SECURITY,
      'content-type': renderable ? row.mediaType : 'application/octet-stream',
      'content-length': String(row.size),
      ...(renderable ? {} : { 'content-disposition': `attachment; filename="${ctx.params.key}"` }),
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
}
