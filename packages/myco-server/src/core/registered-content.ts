import { SHA256 } from '@stablelib/sha256';
import type { PreparedStatement, RelationalStore, ContentStore } from './adapters.js';
import { blobObjectKey } from './blob-objects.js';
import { consumeUploadAuthority, recordBlobCandidates, releaseBlobs } from './object-release.js';
import { BLOB_RESERVATION_TTL_MS } from '../constants.js';
import { sha256HexOf, utf8 } from '../hash.js';
import { credentialLive } from '../ingest/live-credential.js';
import { measuredContentEnv } from './content-budget.js';
import { registerContentStatement } from './content-registration.js';

export interface DerivedContentSource {
  projectId: string;
  sessionId: string;
  eventId: string;
  tokenId: string;
  envelopeHash: string;
  sourceKind: 'event' | 'tool-input' | 'receipt' | 'transcript';
  resourceId?: string;
  memberTokenId?: string;
}

export interface VerifiedContent {
  key: string;
  generation: string | null;
  size: number;
  digest: string;
  preparationCalls?: number;
}

/** An internal source still belongs to the live Project and untombstoned session. */
const sourceLive = (source: DerivedContentSource) => {
  const credential = source.memberTokenId === undefined ? { sql: '1', params: [] } : credentialLive(source.memberTokenId);
  return {
  sql: `(${credential.sql}) AND EXISTS (SELECT 1 FROM projects WHERE project_id=?)
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)
    AND NOT EXISTS (SELECT 1 FROM events WHERE project_id=? AND event_id=? AND envelope_hash<>?)`,
  params: [...credential.params, source.projectId, source.projectId, source.sessionId, source.projectId, source.eventId, source.envelopeHash],
}; };

/** A failed assertion aborts the entire publication or clear transaction. */
export function contentAssertion(db: RelationalStore, sql: string, params: readonly unknown[]): PreparedStatement[] {
  return [db.prepare(`INSERT INTO storage_content_guard(ok) SELECT CASE WHEN (${sql}) THEN 1 ELSE 0 END`).bind(...params),
    db.prepare('DELETE FROM storage_content_guard')];
}

/** Exact immutable generation and durable read-back evidence required by a content transition. */
export function verifiedContentSql(source: DerivedContentSource, content: VerifiedContent): { sql: string; params: unknown[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM registered_content_proofs p JOIN blobs b
      ON b.project_id=p.project_id AND b.key=p.key AND b.generation IS p.generation AND b.size=p.size
      WHERE p.project_id=? AND p.source_kind=? AND p.source_id=? AND p.event_id=? AND p.envelope_hash=?
        AND p.key=? AND p.generation IS ? AND p.digest=p.key AND p.size=? AND p.durable=1)`,
    params: [source.projectId, source.sourceKind, source.resourceId ?? source.eventId, source.eventId, source.envelopeHash,
      content.key, content.generation, content.size],
  };
}

/** Verifies a complete stored body in bounded chunks without retaining the body in memory. */
export async function verifyContentObject(env: Pick<ContentStore, 'blobs'>, physical: string, size: number, digest: string): Promise<void> {
  const object = await env.blobs.get(physical);
  if (object === null) throw new Error('content_archive_missing');
  if (object.size !== size) { await object.body.cancel(); throw new Error('content_archive_size_mismatch'); }
  const hash = new SHA256();
  let bytes = 0;
  const reader = object.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > size) throw new Error('content_archive_size_mismatch');
      hash.update(next.value);
    }
    const actual = [...hash.digest()].map(value => value.toString(16).padStart(2, '0')).join('');
    if (bytes !== size || actual !== digest) throw new Error('content_archive_digest_mismatch');
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); hash.clean(); }
  }
}

/** Registered generation publication under immutable internal source authority. */
export async function prepareDerivedStream(
  env: Pick<ContentStore, 'db' | 'blobs'>, source: DerivedContentSource,
  body: { size: number; digest: string; stream(): ReadableStream<Uint8Array> }, now: number,
): Promise<VerifiedContent> {
  const db = env.db;
  const publicationStarted=Date.now();
  const live = sourceLive(source);
  const sourceId = source.resourceId ?? source.eventId;
  const existing = await db.prepare(`SELECT generation,size FROM blobs WHERE project_id=? AND key=?`)
    .bind(source.projectId, body.digest).first<{ generation: string | null; size: number }>();
  if (existing !== null) {
    if (existing.size !== body.size) throw new Error('content_registration_unverified');
    const physical = blobObjectKey(source.projectId, body.digest, existing.generation);
    const durable = await db.prepare(`SELECT 1 AS held FROM registered_content_proofs
      WHERE project_id=? AND key=? AND generation IS ? AND digest=? AND size=? AND durable=1 LIMIT 1`)
      .bind(source.projectId, body.digest, existing.generation, body.digest, body.size).first();
    if (durable === null && await env.blobs.ensureDurable?.(physical) !== true) throw new Error('content_durability_unavailable');
    await verifyContentObject(env, physical, body.size, body.digest);
    await db.batch([
      ...contentAssertion(db, `${live.sql} AND EXISTS (SELECT 1 FROM blobs WHERE project_id=? AND key=? AND generation IS ? AND size=?)`,
        [...live.params, source.projectId, body.digest, existing.generation, body.size]),
      db.prepare(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT DO NOTHING`)
        .bind(source.projectId, body.digest, existing.generation, source.sourceKind, sourceId, source.eventId, source.envelopeHash, source.sessionId, body.digest, body.size, now),
    ]);
    return { key: body.digest, digest: body.digest, size: body.size, generation: existing.generation };
  }
  const generation = crypto.randomUUID();
  const physical = blobObjectKey(source.projectId, body.digest, generation);
  const admitted = await db.batch([
    ...contentAssertion(db, live.sql, live.params),
    db.prepare(`INSERT INTO blob_reservations(reservation_id,project_id,key,token_id,size,expires_at,authority_kind,
      source_kind,source_id,source_event_id,source_envelope_hash,source_session_id) VALUES(?,?,?,?,?,?,'server',?,?,?,?,?)`)
      .bind(generation, source.projectId, body.digest, source.tokenId, body.size, now+BLOB_RESERVATION_TTL_MS,
        source.sourceKind, sourceId, source.eventId, source.envelopeHash, source.sessionId),
  ]);
  if (admitted.at(-1)?.meta.changes !== 1) throw new Error('content_reservation_refused');
  let published = false;
  try {
    const object = await env.blobs.put(physical, body.stream(), { size:body.size,sha256: body.digest, httpMetadata: { contentType: 'application/json' } });
    if (object.durable !== true) throw new Error('content_durability_unavailable');
    if (object.size !== body.size) throw new Error('content_archive_size_mismatch');
    await verifyContentObject(env, physical, body.size, body.digest);
    await db.batch([
      ...contentAssertion(db, `${live.sql} AND EXISTS (SELECT 1 FROM blob_reservations WHERE reservation_id=?
        AND project_id=? AND key=? AND size=? AND token_id=? AND source_session_id=? AND expires_at>?
        AND authority_kind='server' AND source_kind=? AND source_id=? AND source_event_id=? AND source_envelope_hash=?)`,
        [...live.params,generation,source.projectId,body.digest,body.size,source.tokenId,source.sessionId,now+Math.max(0,Date.now()-publicationStarted),
          source.sourceKind, sourceId, source.eventId, source.envelopeHash]),
      registerContentStatement(db,{projectId:source.projectId,key:body.digest,size:body.size,mediaType:'application/json',
        tokenId:source.tokenId,receivedAt:now,generation,authority:live}),
      ...contentAssertion(db, `EXISTS (SELECT 1 FROM blobs WHERE project_id=? AND key=? AND generation IS ? AND size=?)`,
        [source.projectId, body.digest, generation, body.size]),
      db.prepare(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT DO NOTHING`)
        .bind(source.projectId, body.digest, generation, source.sourceKind, sourceId, source.eventId, source.envelopeHash, source.sessionId, body.digest, body.size, now),
      db.prepare('DELETE FROM blob_reservations WHERE reservation_id=?').bind(generation),
    ]);
    published = true;
    return { key: body.digest, digest: body.digest, size: body.size, generation };
  } finally {
    if (!published) await db.batch(consumeUploadAuthority(db, generation, now));
  }
}

/** Prepares complete admitted logical bytes before their projection publishes a display prefix. */
export async function prepareDerivedContent(env: Pick<ContentStore, 'db' | 'blobs'>, source: DerivedContentSource, text: string, now: number): Promise<VerifiedContent> {
  const bytes = utf8(text);
  const digest = await sha256HexOf(bytes);
  const measured=measuredContentEnv(env);
  const content=await prepareDerivedStream(measured.env, source, { size: bytes.byteLength, digest,
    stream: () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) }, now);
  return { ...content,preparationCalls:measured.usage.statements+measured.usage.blobCalls };
}

/** Releases a prepared input that no committed logical field adopted. */
export async function discardDerivedContent(env: Pick<ContentStore, 'db'|'blobs'>, source: DerivedContentSource, key: string, now: number): Promise<number> {
  const measured=measuredContentEnv(env);
  const db=measured.env.db;
  const pairs = [{ projectId: source.projectId, key }];
  if(source.sourceKind==='tool-input' && await db.prepare(`SELECT 1 AS adopted FROM tool_calls
    WHERE project_id=? AND tool_call_id=? AND input_blob_key=?`).bind(source.projectId,source.resourceId??source.eventId,key).first()!==null)
    return measured.usage.statements;
  await db.batch([
    db.prepare(`DELETE FROM registered_content_proofs WHERE project_id=? AND source_kind=? AND source_id=?
      AND event_id=? AND envelope_hash=? AND key=? AND NOT EXISTS (SELECT 1 FROM tool_calls t
        WHERE t.project_id=registered_content_proofs.project_id AND t.tool_call_id=registered_content_proofs.source_id
          AND t.input_blob_key=registered_content_proofs.key)`)
      .bind(source.projectId, source.sourceKind, source.resourceId ?? source.eventId, source.eventId, source.envelopeHash, key),
    ...recordBlobCandidates(db, pairs, now),
  ]);
  await releaseBlobs(db, pairs, now);
  return measured.usage.statements+measured.usage.blobCalls;
}
