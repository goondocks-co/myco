import { admitBlobUpload, journalUnpublishedUpload, reconcileBlobUpload } from '../db/storage/blob-admission.js';
import { beginUploadIntent, settleObjectIntent, consumeUpload, discardUnissuedUpload } from '../db/storage/object-lifecycle.js';
import { verifiedBlobReference } from '../core/raw-provenance.js';
import type { ServerEnv } from '../core/adapters.js';
import type { StreamContext } from '../context.js';
import { BLOB_RESERVATION_TTL_MS, MAX_BLOB_BYTES, RETRY_AFTER_SECONDS } from '../constants.js';
import { RawResourceReader } from '../core/raw-resources.js';
import { classifyBlobStore, emit, TokenRevokedError, UNAVAILABLE, type Classifier } from '../telemetry.js';
import { registerContentStatement } from '../core/content-registration.js';

export const MAX_MEDIA_TYPE_CHARS = 128;
const TOKEN = String.raw`[A-Za-z0-9!#$%&'*+.^_\`|~-]+`;
/** RFC 7231 media type: type "/" subtype followed by zero or more `; name=value` parameters, values as tokens or quoted strings. */
/** A quoted parameter value: RFC 7230 qdtext without the separators a canonical form would re-parse as further parameters. */
const QUOTED = String.raw`"[^"\\;=\x00-\x1F\x7F]*"`;
const MEDIA_TYPE = new RegExp(String.raw`^(${TOKEN})/(${TOKEN})((?:\s*;\s*${TOKEN}=(?:${QUOTED}|${TOKEN}))*)\s*$`);

/** Stored — `mediaType` is the blob row's, the first uploader's, so a duplicate upload with another type sees the stored one — or refused with its stable `code`: a refusal without a `code` cannot be built. */
export type BlobResult =
  | { stored: true; duplicate: boolean; key: string; size: number; mediaType: string }
  | { stored: false; code: Classifier; reason: string };

const TEXT_PLAIN = 'text/plain';
const TEXT_PLAIN_UTF8 = 'text/plain; charset=utf-8';

/** Each `name=value` parameter of a media type's tail, taken whole: a quoted value keeps its separators. */
const PARAMETER = new RegExp(String.raw`;\s*(${TOKEN})=(${QUOTED}|${TOKEN})`, 'g');

/** The canonical form of a media type: lowercase type/subtype, parameters lowercased and joined as `; name=value`; a bare `text/plain` is `text/plain; charset=utf-8`. Null when the header does not parse or is too long. */
export function canonicalMediaType(header: string | null): string | null {
  if (header === null || header.length > MAX_MEDIA_TYPE_CHARS) return null;
  const m = MEDIA_TYPE.exec(header);
  if (!m) return null;
  const params = [...m[3].matchAll(PARAMETER)].map(([, name, value]) => `${name.toLowerCase()}=${value.replace(/"/g, '').toLowerCase()}`);
  const canonical = [`${m[1].toLowerCase()}/${m[2].toLowerCase()}`, ...params].join('; ');
  return canonical === TEXT_PLAIN ? TEXT_PLAIN_UTF8 : canonical;
}

/** A terminal refusal on the stream route. An unread request body needs no handling: the platform rejects a body that never completes before the Worker is invoked, and absorbs one that did. */
function refuse(ctx: StreamContext, reason: string, classifier: Classifier): Response {
  emit({ kind: 'blob_refused', projectId: ctx.projectId, tokenId: ctx.tokenId, reason: classifier });
  return Response.json({ stored: false, code: classifier, reason } satisfies BlobResult);
}

/**
 * Content-addressed upload under its own authority.
 *
 * - **Authority first.** One statement admits the body while the credential is live (`credentialLive`) and writes the reservation row, whose id
 *   is this upload's generation. Nothing touches the store before it commits. The same batch consumes the credential's
 *   expired authorities, journaling their bytes (`core/object-release.ts`).
 * - **Bytes under the generation.** A registered row decides a duplicate before any byte moves. With none, the body is
 *   stored at `<project>/<key>~<generation>` (`core/blob-objects.ts`), a name no other write uses. Bytes already in the
 *   store under another name are never taken as this upload's.
 * - **Reconcile.** The reservation moves to the size the store recorded, while the credential is still live.
 * - **Registration consumes the authority.** One batch registers the row only while the reservation is live, counts
 *   the bytes on the credential, and removes the reservation; the same batch journals this upload's bytes when a row already
 *   registers the content or the authority expired.
 * - **Every other exit consumes it too.** A refusal, a failed or unknown store write, or an error journals the
 *   generation's bytes and removes the reservation in one batch. An unresolved PUT retains a durable settlement intent;
 *   the wake job revisits its exact key after authority is consumed, including after an acknowledged delete.
 *
 * An upload whose authority expired, or another consumer took first, is answered as retryable: a retry stores under a fresh
 * generation.
 */
export async function handleBlob(env: ServerEnv, request: Request, ctx: StreamContext): Promise<Response> {
  const key = ctx.params.key;
  const mediaType = canonicalMediaType(request.headers.get('content-type'));
  if (mediaType === null) return refuse(ctx, 'invalid content-type', 'media_type');
  const size = ctx.contentLength;
  if (size === 0) return refuse(ctx, 'empty body', 'empty_body');
  const db = env.db;

  const reservationId = crypto.randomUUID();
  const expiresAt = ctx.now + BLOB_RESERVATION_TTL_MS;

  /** Admission and the reservation are one statement: the row is written only while the credential is live. No volume is an admission: capture is never refused for the bytes a credential has stored (#1416). The credential's expired authorities are consumed in the same transaction, so a credential whose requests keep dying accumulates rows no faster than it makes them; the sweep is keyed on the credential alone, and the drain consumes what a credential that never uploads again leaves. */
  if (!await admitBlobUpload(db,reservationId,ctx.projectId,key,ctx.tokenId,size,expiresAt,ctx.now)) throw new TokenRevokedError(ctx.tokenId);
  const reconcile = (storedSize: number) => reconcileBlobUpload(db,storedSize,ctx.clock()+BLOB_RESERVATION_TTL_MS,reservationId,ctx.tokenId);
  const expired = (): Response => {
    emit({ kind: 'blob_upload_expired', projectId: ctx.projectId, tokenId: ctx.tokenId });
    return Response.json({ stored: false, code: UNAVAILABLE, reason: UNAVAILABLE }, { status: 503, headers: { 'retry-after': String(RETRY_AFTER_SECONDS) } });
  };

  const duplicate = (row: { size: number; media_type: string }): Response => {
    emit({ kind: 'blob_duplicate', projectId: ctx.projectId, tokenId: ctx.tokenId, sameType: row.media_type === mediaType });
    return Response.json({ stored: true, duplicate: true, key, size: row.size, mediaType: row.media_type } satisfies BlobResult);
  };

  let consumed = false;
  let physical: string | undefined;
  let putSettled = false;
  try {
    const existing = await db.prepare(`SELECT size, media_type FROM blobs WHERE project_id = ? AND key = ?`).bind(ctx.projectId, key).first<{ size: number; media_type: string }>();
    if (existing) {
      const credential = await db.prepare('SELECT member_id FROM member_credentials WHERE id = ?').bind(ctx.tokenId).first<{ member_id: string }>();
      if (credential !== null && await new RawResourceReader(env, { projectId: ctx.projectId }, { kind: 'member', memberId: credential.member_id })
        .allows({ kind: 'blob', id: key }, 'read')) return duplicate(existing);
    }

    let storedSize: number;
    try {
      physical = await beginUploadIntent(db,reservationId,ctx.clock());
      const object = await env.blobs.put(physical, request.body, { sha256: key, httpMetadata: { contentType: mediaType } });
      putSettled = true;
      storedSize = object.size;
    } catch (err) {
      if (classifyBlobStore(err, env.platform?.classifyBlobFailure) === 'digest') return refuse(ctx, 'digest mismatch', 'digest_mismatch');
      throw err;
    }
    // The ceiling holds against the size the store recorded, not only against the length the caller declared.
    if (storedSize > MAX_BLOB_BYTES) return refuse(ctx, `blob exceeds ${MAX_BLOB_BYTES} bytes`, 'blob_cap');
    const reconciled = await reconcile(storedSize);
    if (reconciled === 'consumed') {
      consumed = true;
      return expired();
    }
    if (reconciled === 'revoked') throw new TokenRevokedError(ctx.tokenId);

    const at = ctx.clock();
    const live = `EXISTS (SELECT 1 FROM blob_reservations WHERE reservation_id = ? AND expires_at > ?)`;
    await db.batch([
      journalUnpublishedUpload(db,physical,at,reservationId,ctx.projectId,key),
      registerContentStatement(db,{projectId:ctx.projectId,key,size:storedSize,mediaType,tokenId:ctx.tokenId,
        receivedAt:ctx.now,generation:reservationId,authority:{sql:live,params:[reservationId,at]}}),
      db.prepare(`UPDATE member_credentials SET bytes_written = bytes_written + (? * changes()) WHERE id = ?`).bind(storedSize, ctx.tokenId),
      verifiedBlobReference(db, { projectId: ctx.projectId, key, tokenId: ctx.tokenId, reservationId, at }),
      db.prepare(`DELETE FROM blob_reservations WHERE reservation_id = ?`).bind(reservationId),
    ]);
    consumed = true;
    const row = await db.prepare(`SELECT size, media_type, generation FROM blobs WHERE project_id = ? AND key = ?`).bind(ctx.projectId, key)
      .first<{ size: number; media_type: string; generation: string | null }>();
    if (row?.generation === reservationId) {
      emit({ kind: 'blob_stored', projectId: ctx.projectId, tokenId: ctx.tokenId });
      return Response.json({ stored: true, duplicate: false, key, size: storedSize, mediaType } satisfies BlobResult);
    }
    if (row !== null) return duplicate(row);
    return expired();
  } finally {
    if (!consumed) {
      await (physical === undefined
        ? discardUnissuedUpload(db,reservationId)
        : consumeUpload(db,reservationId,ctx.clock()));
    }
    if (physical !== undefined) await settleObjectIntent(db,physical,ctx.clock(),putSettled);
  }
}
