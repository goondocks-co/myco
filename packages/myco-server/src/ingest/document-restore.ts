import { PublicationOwnershipBuilding } from '../db/documents/ownership.js';
import { PublicationRestoreBuilding } from '../db/documents/readiness.js';
import { isTombstoned, sessionPresent } from '../db/sessions/tombstones.js';
import { decodePageChunk, type DecodedChunk, type DocRecord } from '../content/document.js';
import { readStoredObject } from '../core/stored-object.js';
/**
 * A backup's session documents are restored from its immutable chunks. A session without a live document is converted
 * from the artifact's snapshot; a live document merges the snapshot's records. A converting session's records,
 * continuation, publication frontier and catalog become live in one transaction.
 */
import type { ServerEnv } from '../core/adapters.js';
import { commit, type Bound } from '../db/index.js';
import { sha256HexOf } from '../hash.js';
import {
  clearForConversionWrites, holdArtifactChunkWrite, nothingPublishedGuard, openRestoredDocumentWrite, registeredArtifactObject, restoredDocumentHeld,
  restoreRegistrationGuard, restoreTarget, type RestoreSelection,
} from '../db/documents/restore-conversion.js';
import { SessionDocument } from '../content/session-pages.js';
import { generationHasChunks } from '../db/documents/directory.js';
import { DocumentBatch, publicationStatement } from './document-batch.js';
import type { RestoreDocuments } from '../core/backup.js';

type Row = Record<string, unknown>;

interface SessionRef { projectId: string; sessionId: string }
interface ArtifactDocument { records:DocRecord[]; states:Map<string,Row>; owners:DecodedChunk['owners']; plans:Set<string>; frontiers:readonly Row[]; chunks:readonly Row[] }
type HeldDocument = SessionRef & { snapshot: ArtifactDocument };
interface DocumentRestorePlan {
  convert: HeldDocument[];
  merge: HeldDocument[];
}
const PLAN_STALE = 'restore_plan_stale';
class RestorePlanStale extends Error {
  constructor() { super(`${PLAN_STALE}: a session this restore converts went live after the restore was planned; restore the artifact again`); }
}
const IN_PROGRESS = 'restore_in_progress';
class RestoreInProgress extends Error {
  constructor() { super(`${IN_PROGRESS}: another restore holds a session this restore converts; restore the artifact again once it finishes`); }
}

/** Every record id a live document holds, as `kind:id`, read chunk by chunk. */
async function documentIds(env: Pick<ServerEnv, 'db' | 'blobs'>, ref: SessionRef): Promise<Set<string> | null> {
  const doc = await SessionDocument.open(env, ref.projectId, ref.sessionId);
  if (doc === null) return null;
  const ids = new Set<string>();
  for (let after = -1; ;) {
    const read = await doc.chunksAfter(after, 8);
    for (const chunk of read.chunks) for (const page of chunk.pages) for (const record of page.records) ids.add(`${record.k}:${record.id}`);
    if (!read.more || read.chunks.length === 0) return ids;
    after = read.chunks.at(-1)!.chunkNo;
  }
}

/** Reads immutable artifact chunks through the destination's registered objects and verifies every digest. */
async function artifactDocument(env:Pick<ServerEnv,'db'|'blobs'>, tables:ReadonlyMap<string,readonly Row[]>, doc:Row):Promise<ArtifactDocument>{
  if(doc.state!=='live'||!Number.isSafeInteger(doc.generation))throw new Error('artifact_document_incomplete');
  const same=(row:Row)=>row.project_id===doc.project_id&&row.session_id===doc.session_id&&row.generation===doc.generation;
  const chunks=(tables.get('session_chunks')??[]).filter(same).sort((a,b)=>Number(a.chunk_no)-Number(b.chunk_no));
  const byNumber=new Map(chunks.map(row=>[row.chunk_no,row]));
  if(byNumber.size!==chunks.length)throw new Error('artifact_document_directory_invalid');
  const bytes=new Map<unknown,Uint8Array<ArrayBuffer>>();
  const read=async(row:Row)=>{
    const physical=await registeredArtifactObject(env.db,doc.project_id as string,row.blob_key as string);
    if(!physical)throw new Error('artifact_document_object_missing');
    const object=await readStoredObject(env.blobs,physical,Number(row.bytes));
    if(object.kind!=='read'||await sha256HexOf(object.bytes)!==row.blob_key)throw new Error('artifact_document_digest');
    return object.bytes;
  };
  const snapshot:ArtifactDocument={records:[],states:new Map(),owners:null,plans:new Set(),frontiers:(tables.get('transcript_publication')??[]).filter(same),chunks};
  for(const row of chunks){
    if(row.kind==='body'&&row.metadata!==1)continue;
    if(row.kind!=='page'&&row.metadata!==1)throw new Error('artifact_document_chunk_kind');
    const chunk=await decodePageChunk(new Blob([await read(row)]).stream());
    for(const [key,state]of chunk.states)snapshot.states.set(key,state);
    if(chunk.owners!==null){
      const owners=new Map(snapshot.owners??[]);
      for(const [key,owner]of chunk.owners){
        const held=owners.get(key);
        if(held!==undefined&&(held.thread!==owner.thread||held.record!==owner.record))throw new Error('artifact_document_owner_conflict');
        owners.set(key,owner);
      }
      snapshot.owners=[...owners];
    }
    for(const key of chunk.plans??[])snapshot.plans.add(key);
    if(row.metadata===1)continue;
    for(const page of chunk.pages)for(const original of page.records){
      const record={...original};
      for(const [field,ref]of Object.entries(record.bodies??{})){
        const body=byNumber.get(ref.chunk);
        if(body?.kind!=='body'||body.blob_key!==ref.digest||body.bytes!==ref.bytes)throw new Error('artifact_document_body_reference');
        let held=bytes.get(ref.chunk);if(held===undefined){held=await read(body);bytes.set(ref.chunk,held);}
        record[field]=new TextDecoder('utf-8',{fatal:true}).decode(held);
      }
      delete record.bodies;snapshot.records.push(record);
    }
  }
  if(snapshot.records.filter(row=>row.k==='prompt').length!==doc.prompts)throw new Error('artifact_document_record_count');
  return snapshot;
}

/** What the plan before any write decided for one session: converted from its snapshot, or merged into its live document. */
type DocumentDecision = 'convert' | 'merge';

/** Every session document the artifact holds, by key, sorted: the order a restore walks them in. */
function documentSessionKeys(byTable: ReadonlyMap<string, readonly Row[]>): string[] {
  return [...new Set((byTable.get('session_documents') ?? []).map((doc) => JSON.stringify([doc.project_id, doc.session_id])))].sort();
}

/**
 * Decides each session document the artifact holds, reading the target. `only` limits it to a page of sessions. With
 * `decided`, the decisions the plan before any write made hold: a session decided for conversion converts while its
 * live document is still empty (the restored transcripts and events open one), and merges once an earlier pass of the
 * same restore filled it; a session the first plan left out stays out.
 */
async function planDocumentRestore(env: Pick<ServerEnv, 'db' | 'blobs'>, byTable: ReadonlyMap<string, readonly Row[]>,
  page: { only?: ReadonlySet<string>; decided?: ReadonlyMap<string, DocumentDecision> } = {}): Promise<DocumentRestorePlan> {
  const plan: DocumentRestorePlan = { convert: [], merge: [] };
  for (const doc of byTable.get('session_documents') ?? []) {
    if (typeof doc.project_id !== 'string' || typeof doc.session_id !== 'string') throw new Error('artifact_document_identity');
    const ref = { projectId: doc.project_id, sessionId: doc.session_id };
    const key = JSON.stringify([ref.projectId, ref.sessionId]);
    if (page.only !== undefined && !page.only.has(key)) continue;
    const decision = page.decided?.get(key);
    if (page.decided !== undefined && decision === undefined) continue;
    const snapshot = await artifactDocument(env, byTable, doc);
    if (await isTombstoned(env.db, ref.projectId, ref.sessionId)) continue;
    const held = await documentIds(env, ref);
    const converts = decision === undefined ? held === null : decision === 'convert' && (held === null || held.size === 0);
    (converts ? plan.convert : plan.merge).push({ ...ref, snapshot });
  }
  return plan;
}

/** The artifact's saved continuation, ownership and frontier for a converting session, without replaying its records. */
function artifactFrontiers(batch: DocumentBatch, snapshot: ArtifactDocument): Row[] {
  for (const [key, state] of snapshot.states) batch.writer.states.set(key, state);
  for (const [key, owner] of snapshot.owners ?? []) batch.writer.owners.set(key, owner);
  return snapshot.frontiers.map(row=>({t:row.transcript_id,o:row.published_offset,l:row.segment_lines,p:row.open_prompt_id,
    u:row.unfinished,r:row.reply_unfinished,a:row.reply_latest_at,ps:row.prompt_scheme,rs:row.record_scheme,v:row.parser_version,s:row.state,f:row.failure,w:row.awaited_size,n:row.placed_records??null,d:row.placed_digest??null,diag:row.diagnostic??null}));
}

/** Publishes each restored document atomically against its current catalog and frontier. */
export async function applyDocumentRestore(env: Pick<ServerEnv, 'db' | 'blobs'>, plan: DocumentRestorePlan, now: number): Promise<void> {
  for(const session of [...plan.convert,...plan.merge])for(const chunk of session.snapshot.chunks)
    await commit(env.db,holdArtifactChunkWrite(session.projectId,session.sessionId,{key:chunk.blob_key as string,source:chunk.source_id as string},now));
  for (const session of plan.convert) await mergeSession(env, session, now, true);
  for (const session of plan.merge) await mergeSession(env, session, now, false);
}

async function mergeSession(env: Pick<ServerEnv, 'db' | 'blobs'>, session: HeldDocument, now: number, plannedConversion: boolean): Promise<void> {
  const db = env.db;
  const held = await restoreTarget(db, session.projectId, session.sessionId);
  if (held === null || (held.state !== null && !['live','convert'].includes(held.state))) throw new RestorePlanStale();
  if (held.restore_hold != null && (held.due_at === null || held.due_at > now)) throw new RestoreInProgress();
  if (held.state === 'live' && held.generation === null) throw new RestorePlanStale();
  const absent = held.state === null;
  const converting = held.state !== 'live';
  if (plannedConversion && !converting && (held.next_chunk !== 0 || await generationHasChunks(db, session.projectId, session.sessionId, held.generation ?? 1))) throw new RestorePlanStale();
  const generation = held.generation;
  const selection: RestoreSelection = absent ? { project: session.projectId, session: session.sessionId, absent: true }
    : { project: session.projectId, session: session.sessionId, absent: false, state: held.state!, hold: held.restore_hold, now, generation, nextChunk: held.next_chunk };
  const doc = { ...held, generation: converting ? (generation ?? 0) + 1 : generation!,
    ...(converting ? { next_chunk: 0, prompts: 0, first_prompt: null, open_turn_key: null, build: null } : {}) };
  const batch = new DocumentBatch(env, session.projectId, session.sessionId, doc);
  try { await batch.open(); }
  catch(error) { if(error instanceof PublicationOwnershipBuilding)throw new PublicationRestoreBuilding('ownership',error.failure); throw error; }
  const frontiers = plannedConversion ? artifactFrontiers(batch, session.snapshot) : [];
  await batch.place(session.snapshot.records, doc.agent);
  for(const key of session.snapshot.plans)batch.writer.plans.add(key);
  await batch.commit(batch.writer.changed, 'live', now, (version) => restoreRegistrationGuard(selection, version), (registered) => {
    const before: Bound[] = restoredDocumentHeld(selection, batch.expectedChunks(registered), doc.generation);
    if (absent) before.push(openRestoredDocumentWrite(session.projectId, session.sessionId, doc.generation, now));
    if (plannedConversion && !converting) before.push(...nothingPublishedGuard(session.projectId, session.sessionId));
    if (converting && !absent) before.push(...clearForConversionWrites(session.projectId, session.sessionId, doc.generation, now));
    return { before, after: [...(frontiers.length===0?[]:[publicationStatement(session.projectId,session.sessionId,doc.generation,now,frontiers)]), batch.restoredCatalogStatement(now, { generation: doc.generation, build: doc.build })] };
  });
}

/**
 * The document side of a restore over this environment, as `core/backup.ts` takes it: the whole plan before any
 * write, then a page of sessions at a time, each page planned again against the documents as they stand.
 */
export function restoreDocuments(env: Pick<ServerEnv, 'db' | 'blobs'>): RestoreDocuments {
  return {
    sessions: documentSessionKeys,
    async plan(byTable) {
      const plan = await planDocumentRestore(env, byTable);
      const key = (session: HeldDocument) => JSON.stringify([session.projectId, session.sessionId]);
      return {
        summary: { convert: plan.convert.length, merge: plan.merge.length },
        decisions: [...plan.convert.map((session): [string, string] => [key(session), 'convert']), ...plan.merge.map((session): [string, string] => [key(session), 'merge'])],
      };
    },
    async apply(byTable, { after, limit, now, decisions }) {
      const remaining = documentSessionKeys(byTable).filter((key) => after === null || key > after);
      const page = remaining.slice(0, limit);
      if (page.length === 0) return { sessions: 0, last: null };
      await applyDocumentRestore(env, await planDocumentRestore(env, byTable, { only: new Set(page), decided: new Map(decisions as readonly [string, DocumentDecision][]) }), now);
      return { sessions: page.length, last: page.length === remaining.length ? null : page.at(-1)! };
    },
  };
}
