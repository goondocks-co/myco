import { SHA256 } from '@stablelib/sha256';
import type { PreparedStatement, RelationalStore, ContentStore } from './adapters.js';
import { blobObjectKey } from './blob-objects.js';
import { admitDerivedUpload, contentRegistration, durableProofHeld, publishDerivedUpload, recordProofOfRegistered, type DerivedAuthority } from '../db/storage/content-lifecycle.js';
import { settleUpload } from '../db/storage/object-lifecycle.js';
import { BLOB_RESERVATION_TTL_MS, TRANSCRIPT_PARSE_ADAPTER } from '../constants.js';
import { sha256HexOf, utf8 } from '../hash.js';
import { credentialLive } from '../db/identity/capture-credential.js';
import { measuredContentEnv } from './content-budget.js';

export interface DerivedContentSource {
  projectId: string;
  sessionId: string;
  eventId: string;
  tokenId: string;
  envelopeHash: string;
  sourceKind: 'event' | 'tool-input' | 'receipt' | 'transcript' | 'bundle' | 'document';
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
export interface ContentPublicationGuard { sql: string; params: readonly unknown[] | (() => readonly unknown[]) }

/** An internal source still belongs to the live Project and untombstoned session. */
const sourceLive = (source: DerivedContentSource) => {
  const credential = source.memberTokenId === undefined ? { sql: '1', params: [] } : credentialLive(source.memberTokenId);
  // A server source may re-derive the transcript parser's own earlier event for its session; the replay gate decides whether it lands.
  const rederived = source.memberTokenId === undefined ? ` AND NOT (producer_adapter='${TRANSCRIPT_PARSE_ADAPTER}' AND session_id=?)` : '';
  return {
  sql: `(${credential.sql}) AND EXISTS (SELECT 1 FROM projects WHERE project_id=?)
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)
    AND NOT EXISTS (SELECT 1 FROM events WHERE project_id=? AND event_id=? AND envelope_hash<>?${rederived})`,
  params: [...credential.params, source.projectId, source.projectId, source.sessionId, source.projectId, source.eventId, source.envelopeHash,
    ...(source.memberTokenId === undefined ? [source.sessionId] : [])],
}; };

/** A failed assertion aborts the entire publication or clear transaction. */
export function contentAssertion(db: RelationalStore, sql: string, params: readonly unknown[],
  when?: { sql: string; params: readonly unknown[] }): PreparedStatement[] {
  return [db.prepare(`INSERT INTO storage_content_guard(ok) SELECT CASE WHEN (${sql}) THEN 1 ELSE 0 END
    ${when === undefined ? '' : `WHERE (${when.sql})`}`).bind(...params,...(when?.params??[])),
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
  return visitVerifiedContent(env,physical,size,digest);
}

/** Complete text is returned only after its registered size and digest are verified. */
export async function readVerifiedContentText(env:Pick<ContentStore,'blobs'>,physical:string,size:number,digest:string):Promise<string>{
  const decoder=new TextDecoder('utf-8',{fatal:true}),parts:string[]=[];
  let invalid: TypeError | undefined;
  const decode=(bytes?:Uint8Array,stream=false)=>{
    try{return decoder.decode(bytes,{stream});}
    catch(error){if(!(error instanceof TypeError))throw error;invalid=error;return '';}
  };
  await visitVerifiedContent(env,physical,size,digest,bytes=>parts.push(decode(bytes,true)));
  parts.push(decode());
  if(invalid!==undefined)throw new Error('content_text_invalid',{cause:invalid});
  return parts.join('');
}

async function visitVerifiedContent(env:Pick<ContentStore,'blobs'>,physical:string,size:number,digest:string,chunk?:(bytes:Uint8Array)=>void):Promise<void>{
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
      chunk?.(next.value);
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
  publicationGuard?: ContentPublicationGuard,
): Promise<VerifiedContent> {
  const db = env.db;
  const publicationStarted=Date.now();
  const sourceAuthority = sourceLive(source);
  const live = () => publicationGuard === undefined ? sourceAuthority : {
    sql: `(${sourceAuthority.sql}) AND (${publicationGuard.sql})`,
    params: [...sourceAuthority.params, ...(typeof publicationGuard.params === 'function'
      ? publicationGuard.params() : publicationGuard.params)],
  };
  const authority: DerivedAuthority = { projectId: source.projectId, key: body.digest, size: body.size, tokenId: source.tokenId, sessionId: source.sessionId,
    eventId: source.eventId, envelopeHash: source.envelopeHash, sourceKind: source.sourceKind, sourceId: source.resourceId ?? source.eventId };
  const guards = () => [live()];
  const existing = await contentRegistration(db, source.projectId, body.digest);
  if (existing !== null) {
    if (existing.size !== body.size) throw new Error('content_registration_unverified');
    const physical = blobObjectKey(source.projectId, body.digest, existing.generation);
    if (!await durableProofHeld(db, source.projectId, body.digest, existing.generation, body.size)
      && await env.blobs.ensureDurable?.(physical) !== true) throw new Error('content_durability_unavailable');
    await verifyContentObject(env, physical, body.size, body.digest);
    await recordProofOfRegistered(db, guards(), authority, existing.generation, now);
    return { key: body.digest, digest: body.digest, size: body.size, generation: existing.generation };
  }
  const generation = crypto.randomUUID();
  const physical = await admitDerivedUpload(db, guards(), generation, authority, now + BLOB_RESERVATION_TTL_MS, now);
  let published = false;
  let stored = false;
  try {
    const object = await env.blobs.put(physical, body.stream(), { size:body.size,sha256: body.digest, httpMetadata: { contentType: 'application/json' } });
    stored = true;
    if (object.durable !== true) throw new Error('content_durability_unavailable');
    if (object.size !== body.size) throw new Error('content_archive_size_mismatch');
    await verifyContentObject(env, physical, body.size, body.digest);
    await publishDerivedUpload(db, guards(), { generation, physical, authority, now, liveAt: now + Math.max(0, Date.now() - publicationStarted) });
    published = true;
    return { key: body.digest, digest: body.digest, size: body.size, generation };
  } finally {
    if (!published) await settleUpload(db, { reservation: generation, physical, authorityConsumed: false, stored }, now);
  }
}

/** Prepares complete admitted logical bytes before their projection publishes a display prefix. */
export async function prepareDerivedContent(env: Pick<ContentStore, 'db' | 'blobs'>, source: DerivedContentSource, text: string, now: number,
  publicationGuard?: ContentPublicationGuard): Promise<VerifiedContent> {
  const bytes = utf8(text);
  const digest = await sha256HexOf(bytes);
  const measured=measuredContentEnv(env);
  const content=await prepareDerivedStream(measured.env, source, { size: bytes.byteLength, digest,
    stream: () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) }, now, publicationGuard);
  return { ...content,preparationCalls:measured.usage.statements+measured.usage.blobCalls };
}
