import type { ServerEnv } from '../core/adapters.js';
import type { StreamContext } from '../context.js';
import { BLOB_RESERVATION_TTL_MS, MAX_BLOB_BYTES } from '../constants.js';
import { classifyBlobStore, emit, type Classifier } from '../telemetry.js';
import { withinQuota } from './quota.js';

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

const objectKey = (projectId: string, key: string) => `${projectId}/${key}`;

/** A terminal refusal on the stream route. An unread request body needs no handling: the platform rejects a body that never completes before the Worker is invoked, and absorbs one that did. */
function refuse(ctx: StreamContext, reason: string, classifier: Classifier): Response {
  emit({ kind: 'blob_refused', projectId: ctx.projectId, tokenId: ctx.tokenId, reason: classifier });
  return Response.json({ stored: false, code: classifier, reason } satisfies BlobResult);
}

/** Content-addressed upload: hold a reservation row against the token's quota, decide duplicate from the blobs row, stream the bytes into the store under the digest, reconcile the reservation to the size the store recorded, then record the row, charge the token and release the reservation in one batch. A digest mismatch is a terminal refusal. Admission is `withinQuota` — the one expression every writer of the counter admits through — so a token already at the ceiling from event traffic is refused before any byte reaches the store. Nothing a request does before its row lands can leave a permanent charge: a reservation that outlives its request stops counting when it expires, every upload re-admits at reconcile with the reservation held for a fresh TTL, and a terminal refusal after the store holds the bytes deletes an object this request put when no row claims it — an adopted object stays for the next uploader with room. */
export async function handleBlob(env: ServerEnv, request: Request, ctx: StreamContext): Promise<Response> {
  const key = ctx.params.key;
  const mediaType = canonicalMediaType(request.headers.get('content-type'));
  if (mediaType === null) return refuse(ctx, 'invalid content-type', 'media_type');
  const size = ctx.contentLength;
  if (size === 0) return refuse(ctx, 'empty body', 'empty_body');
  const db = env.db;

  const reservationId = crypto.randomUUID();
  const expiresAt = ctx.now + BLOB_RESERVATION_TTL_MS;

  /** Admission and the reservation are one statement: the row is written only when `withinQuota` holds for this body. An expired reservation stopped counting the moment it expired; it is deleted here, in the same transaction, so a token whose requests keep dying accumulates rows no faster than it makes them. */
  const admission = withinQuota(ctx, size);
  const [, reserved] = await db.batch([
    db.prepare(`DELETE FROM blob_reservations WHERE project_id = ? AND token_id = ? AND expires_at <= ?`).bind(ctx.projectId, ctx.tokenId, ctx.now),
    db.prepare(`INSERT INTO blob_reservations (reservation_id, project_id, key, token_id, size, expires_at)
                  SELECT ?, ?, ?, ?, ?, ? WHERE ${admission.sql}`)
      .bind(reservationId, ctx.projectId, key, ctx.tokenId, size, expiresAt, ...admission.params),
  ]);
  if (reserved.meta.changes !== 1) return refuse(ctx, 'token write quota exceeded', 'quota');
  const release = () => db.prepare(`DELETE FROM blob_reservations WHERE reservation_id = ?`).bind(reservationId).run();
  /** Every upload reconciles before its row: the reservation moves to the size the store recorded and is held for a fresh TTL, and the quota is re-admitted in the same statement — counting every live reservation but this one — so a request whose room event traffic took while the body streamed is refused here, ahead of the charge, and a second upload in flight is admitted against the size this one will charge. */
  const reconcile = async (storedSize: number): Promise<boolean> => {
    const resized = withinQuota(ctx, storedSize, reservationId);
    const moved = await db
      .prepare(`UPDATE blob_reservations SET size = ?, expires_at = ? WHERE reservation_id = ? AND ${resized.sql}`)
      .bind(storedSize, ctx.clock() + BLOB_RESERVATION_TTL_MS, reservationId, ...resized.params)
      .run();
    return moved.meta.changes === 1;
  };

  const duplicate = (row: { size: number; media_type: string }): Response => {
    emit({ kind: 'blob_duplicate', projectId: ctx.projectId, tokenId: ctx.tokenId, sameType: row.media_type === mediaType });
    return Response.json({ stored: true, duplicate: true, key, size: row.size, mediaType: row.media_type } satisfies BlobResult);
  };

  let landed = false;
  let put = false;
  /** A terminal refusal after the bytes reached the store: an object this request put and no row claims is deleted with it, so a refused upload leaves no orphan; an adopted object stays, held for the next uploader with room to charge it. */
  const refuseStored = async (reason: string, classifier: Classifier): Promise<Response> => {
    if (put && (await db.prepare(`SELECT 1 FROM blobs WHERE project_id = ? AND key = ?`).bind(ctx.projectId, key).first()) === null) {
      await env.blobs.delete(objectKey(ctx.projectId, key));
    }
    return refuse(ctx, reason, classifier);
  };
  try {
    const existing = await db.prepare(`SELECT size, media_type FROM blobs WHERE project_id = ? AND key = ?`).bind(ctx.projectId, key).first<{ size: number; media_type: string }>();
    if (existing) return duplicate(existing);

    let storedSize: number;
    const held = await env.blobs.head(objectKey(ctx.projectId, key));
    if (held) {
      storedSize = held.size;
    } else {
      try {
        const object = await env.blobs.put(objectKey(ctx.projectId, key), request.body, { sha256: key, httpMetadata: { contentType: mediaType } });
        put = true;
        storedSize = object.size;
      } catch (err) {
        if (classifyBlobStore(err, env.platform?.classifyBlobFailure) === 'digest') return refuse(ctx, 'digest mismatch', 'digest_mismatch');
        throw err;
      }
    }
    // The ceiling holds against the size the store recorded, not only against the length the caller declared.
    if (storedSize > MAX_BLOB_BYTES) return refuseStored(`blob exceeds ${MAX_BLOB_BYTES} bytes`, 'blob_cap');
    if (!(await reconcile(storedSize))) return refuseStored('token write quota exceeded', 'quota');

    const batch = await db.batch([
      db.prepare(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, key) DO NOTHING`)
        .bind(ctx.projectId, key, storedSize, mediaType, ctx.tokenId, ctx.now),
      db.prepare(`UPDATE member_credentials SET bytes_written = bytes_written + (? * changes()) WHERE id = ?`).bind(storedSize, ctx.tokenId),
      db.prepare(`DELETE FROM blob_reservations WHERE reservation_id = ?`).bind(reservationId),
    ]);
    if (batch[0].meta.changes === 0) {
      const row = await db.prepare(`SELECT size, media_type FROM blobs WHERE project_id = ? AND key = ?`).bind(ctx.projectId, key).first<{ size: number; media_type: string }>();
      return duplicate(row ?? { size: storedSize, media_type: mediaType });
    }
    landed = true;
    emit({ kind: 'blob_stored', projectId: ctx.projectId, tokenId: ctx.tokenId, healed: held !== null });
    return Response.json({ stored: true, duplicate: false, key, size: storedSize, mediaType } satisfies BlobResult);
  } finally {
    if (!landed) await release();
  }
}
