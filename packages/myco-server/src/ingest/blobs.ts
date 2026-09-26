import type { ServerEnv } from '../core/adapters.js';
import type { StreamContext } from '../context.js';
import { BLOB_RESERVATION_TTL_MS, MAX_BLOB_BYTES, RETRY_AFTER_SECONDS } from '../constants.js';
import { blobObjectKey } from '../core/blob-objects.js';
import { consumeExpiredAuthorities, consumeUploadAuthority } from '../core/object-release.js';
import { classifyBlobStore, emit, TokenRevokedError, UNAVAILABLE, type Classifier } from '../telemetry.js';
import { credentialLive } from './live-credential.js';

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
 *   generation's bytes and removes the reservation in one batch. A write still in flight can only land under a name the
 *   journal already holds or no row will ever register.
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
  const physical = blobObjectKey(ctx.projectId, key, reservationId);

  /** Admission and the reservation are one statement: the row is written only while the credential is live. No volume is an admission: capture is never refused for the bytes a credential has stored (#1416). The credential's expired authorities are consumed in the same transaction, so a credential whose requests keep dying accumulates rows no faster than it makes them; the sweep is keyed on the credential alone, and the drain consumes what a credential that never uploads again leaves. */
  const admission = credentialLive(ctx.tokenId);
  const admitted = await db.batch([
    ...consumeExpiredAuthorities(db, 'token_id = ? AND expires_at <= ?', [ctx.tokenId, ctx.now], ctx.now),
    db.prepare(`INSERT INTO blob_reservations (reservation_id, project_id, key, token_id, size, expires_at)
                  SELECT ?, ?, ?, ?, ?, ? WHERE ${admission.sql}`)
      .bind(reservationId, ctx.projectId, key, ctx.tokenId, size, expiresAt, ...admission.params),
  ]);
  // Revoked after this request authenticated: the pipeline answers 503, and the retry meets the revocation at authentication.
  if (admitted[admitted.length - 1]!.meta.changes !== 1) throw new TokenRevokedError(ctx.tokenId);
  /** Every upload reconciles before its row: the reservation moves to the size the store recorded and is held for a fresh TTL, in one statement that holds only while the credential is live — so a credential revoked while the body streamed registers nothing. An authority another consumer already took changes nothing: its bytes are journaled, and the upload is answered as retryable. */
  const reconcile = async (storedSize: number): Promise<'held' | 'revoked' | 'consumed'> => {
    const resized = credentialLive(ctx.tokenId);
    const moved = await db
      .prepare(`UPDATE blob_reservations SET size = ?, expires_at = ? WHERE reservation_id = ? AND ${resized.sql}`)
      .bind(storedSize, ctx.clock() + BLOB_RESERVATION_TTL_MS, reservationId, ...resized.params)
      .run();
    if (moved.meta.changes === 1) return 'held';
    const held = await db.prepare(`SELECT 1 AS held FROM blob_reservations WHERE reservation_id = ?`).bind(reservationId).first();
    return held === null ? 'consumed' : 'revoked';
  };
  const expired = (): Response => {
    emit({ kind: 'blob_upload_expired', projectId: ctx.projectId, tokenId: ctx.tokenId });
    return Response.json({ stored: false, code: UNAVAILABLE, reason: UNAVAILABLE }, { status: 503, headers: { 'retry-after': String(RETRY_AFTER_SECONDS) } });
  };

  const duplicate = (row: { size: number; media_type: string }): Response => {
    emit({ kind: 'blob_duplicate', projectId: ctx.projectId, tokenId: ctx.tokenId, sameType: row.media_type === mediaType });
    return Response.json({ stored: true, duplicate: true, key, size: row.size, mediaType: row.media_type } satisfies BlobResult);
  };

  let consumed = false;
  let putIssued = false;
  try {
    const existing = await db.prepare(`SELECT size, media_type FROM blobs WHERE project_id = ? AND key = ?`).bind(ctx.projectId, key).first<{ size: number; media_type: string }>();
    if (existing) return duplicate(existing);

    let storedSize: number;
    try {
      putIssued = true;
      const object = await env.blobs.put(physical, request.body, { sha256: key, httpMetadata: { contentType: mediaType } });
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
    const batch = await db.batch([
      db.prepare(`INSERT INTO object_releases (physical, kind, created_at)
                    SELECT ?, 'upload', ? WHERE EXISTS (SELECT 1 FROM blob_reservations WHERE reservation_id = ?)
                      AND (NOT ${live} OR EXISTS (SELECT 1 FROM blobs WHERE project_id = ? AND key = ?))
                    ON CONFLICT (physical) DO NOTHING`)
        .bind(physical, at, reservationId, reservationId, at, ctx.projectId, key),
      db.prepare(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation)
                    SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${live}
                    ON CONFLICT (project_id, key) DO NOTHING`)
        .bind(ctx.projectId, key, storedSize, mediaType, ctx.tokenId, ctx.now, reservationId, reservationId, at),
      db.prepare(`UPDATE member_credentials SET bytes_written = bytes_written + (? * changes()) WHERE id = ?`).bind(storedSize, ctx.tokenId),
      db.prepare(`DELETE FROM blob_reservations WHERE reservation_id = ?`).bind(reservationId),
    ]);
    consumed = true;
    if (batch[1]!.meta.changes === 1) {
      emit({ kind: 'blob_stored', projectId: ctx.projectId, tokenId: ctx.tokenId });
      return Response.json({ stored: true, duplicate: false, key, size: storedSize, mediaType } satisfies BlobResult);
    }
    const row = await db.prepare(`SELECT size, media_type FROM blobs WHERE project_id = ? AND key = ?`).bind(ctx.projectId, key).first<{ size: number; media_type: string }>();
    if (row !== null) return duplicate(row);
    return expired();
  } finally {
    if (!consumed) {
      await db.batch(putIssued
        ? consumeUploadAuthority(db, reservationId, ctx.clock())
        : [db.prepare(`DELETE FROM blob_reservations WHERE reservation_id = ?`).bind(reservationId)]);
    }
  }
}
