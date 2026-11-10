import { PublicationOwnershipBuilding } from '../db/documents/ownership.js';
import { PublicationRestoreBuilding } from '../db/documents/readiness.js';
import { isTombstoned, sessionPresent } from '../db/sessions/tombstones.js';
import { decodePageChunk, type DecodedChunk, type DocRecord } from '../content/document.js';
import { registeredObjectKeySql } from '../core/blob-objects.js';
import { readStoredObject } from '../core/stored-object.js';
/**
 * A backup's session documents are restored from its immutable chunks. A session without a live document is converted
 * from the artifact's snapshot; a live document merges the snapshot's records. A converting session's records,
 * continuation, publication frontier and catalog become live in one transaction.
 */
import type { PreparedStatement, ServerEnv } from '../core/adapters.js';
import { sha256HexOf } from '../hash.js';
import { contentAssertion } from '../core/registered-content.js';
import { SessionDocument } from '../content/session-pages.js';
import { generationHasChunks } from '../db/documents/directory.js';
import { DocumentBatch, publicationStatement, type BatchDocument } from './document-batch.js';
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
    const physical=await env.db.prepare(`SELECT ${registeredObjectKeySql('b.project_id','b.key')} physical FROM blobs b WHERE b.project_id=? AND b.key=?`)
      .bind(doc.project_id,row.blob_key).first<{physical:string}>();
    if(!physical)throw new Error('artifact_document_object_missing');
    const object=await readStoredObject(env.blobs,physical.physical,Number(row.bytes));
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

/** Decides each session document the artifact holds, reading the target before anything is written. */
async function planDocumentRestore(env: Pick<ServerEnv, 'db' | 'blobs'>, byTable: ReadonlyMap<string, readonly Row[]>): Promise<DocumentRestorePlan> {
  const plan: DocumentRestorePlan = { convert: [], merge: [] };
  for (const doc of byTable.get('session_documents') ?? []) {
    if (typeof doc.project_id !== 'string' || typeof doc.session_id !== 'string') throw new Error('artifact_document_identity');
    const ref = { projectId: doc.project_id, sessionId: doc.session_id };
    const snapshot = await artifactDocument(env, byTable, doc);
    if (await isTombstoned(env.db, ref.projectId, ref.sessionId)) continue;
    (await documentIds(env, ref) === null ? plan.convert : plan.merge).push({ ...ref, snapshot });
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

/** The catalog tables a conversion fills before its flip. */
const BUILT = ['document_owners','document_continuations','document_plan_keys','document_metadata_ready','document_metadata_progress','session_chunks', 'session_pages', 'session_sealed_records', 'session_prompts', 'session_paths', 'session_edit_paths', 'session_turn_entries', 'session_turn_totals', 'session_path_build', 'myco_tool_calls', 'transcript_publication'] as const;

/** Publishes each restored document atomically against its current catalog and frontier. */
export async function applyDocumentRestore(env: Pick<ServerEnv, 'db' | 'blobs'>, plan: DocumentRestorePlan, now: number): Promise<void> {
  for(const session of [...plan.convert,...plan.merge])for(const chunk of session.snapshot.chunks)await env.db.prepare(`INSERT OR IGNORE INTO retired_objects(project_id,session_id,blob_key,source_id,retired_at) VALUES(?,?,?,?,?)`)
    .bind(session.projectId,session.sessionId,chunk.blob_key,chunk.source_id,now).run();
  for (const session of plan.convert) await mergeSession(env, session, now, true);
  for (const session of plan.merge) await mergeSession(env, session, now, false);
}

async function mergeSession(env: Pick<ServerEnv, 'db' | 'blobs'>, session: HeldDocument, now: number, plannedConversion: boolean): Promise<void> {
  const db = env.db;
  const state = `state=? AND restore_hold IS ? AND (restore_hold IS NULL OR due_at<=?)`;
  const [docs] = await db.batch([
    db.prepare(`SELECT d.state,d.restore_hold,d.due_at,d.generation, d.next_chunk, d.prompts, d.first_prompt, d.open_turn_key, d.build, s.created_by_token_id token_id,s.agent
      FROM sessions s LEFT JOIN session_documents d ON s.project_id = d.project_id AND s.session_id = d.session_id
      WHERE s.project_id = ?1 AND s.session_id = ?2
        AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=s.project_id AND t.session_id=s.session_id)`).bind(session.projectId, session.sessionId),
  ]);
  const held = docs!.results[0] as (Omit<BatchDocument, 'generation'> & { generation: number | null; state: string | null; restore_hold: string | null; due_at: number | null; build: string | null; agent: string | null }) | undefined;
  if (held === undefined || (held.state !== null && !['live','convert'].includes(held.state))) throw new RestorePlanStale();
  if (held.restore_hold != null && (held.due_at === null || held.due_at > now)) throw new RestoreInProgress();
  if (held.state === 'live' && held.generation === null) throw new RestorePlanStale();
  const absent = held.state === null;
  const converting = held.state !== 'live';
  if (plannedConversion && !converting && (held.next_chunk !== 0 || await generationHasChunks(db, session.projectId, session.sessionId, held.generation ?? 1))) throw new RestorePlanStale();
  const generation = held.generation;
  const owner = absent ? [] : [held.state, held.restore_hold, now];
  const selected = absent ? `NOT EXISTS(SELECT 1 FROM session_documents WHERE project_id=? AND session_id=?)`
    : `EXISTS(SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND ${state} AND generation IS ?)`;
  const selection = [session.projectId,session.sessionId,...owner,...(absent?[]:[generation])];
  const doc = { ...held, generation: converting ? (generation ?? 0) + 1 : generation!,
    ...(converting ? { next_chunk: 0, prompts: 0, first_prompt: null, open_turn_key: null, build: null } : {}) };
  const batch = new DocumentBatch(env, session.projectId, session.sessionId, doc);
  try { await batch.open(); }
  catch(error) { if(error instanceof PublicationOwnershipBuilding)throw new PublicationRestoreBuilding('ownership',error.failure); throw error; }
  const frontiers = plannedConversion ? artifactFrontiers(batch, session.snapshot) : [];
  await batch.place(session.snapshot.records, doc.agent);
  for(const key of session.snapshot.plans)batch.writer.plans.add(key);
  await batch.commit(batch.writer.changed, 'live', now, (version) => ({
    sql: `${selected}
      AND EXISTS (SELECT 1 FROM retired_objects WHERE project_id=? AND session_id=? AND blob_key=? AND source_id=?)`,
    params: [...selection, session.projectId, session.sessionId, version.key, version.sourceId],
  }), (registered) => {
    const set = batch.documentSet(now);
    const before: PreparedStatement[] = contentAssertion(db, `(${selected})
      AND NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)
      ${absent ? '' : 'AND EXISTS(SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND next_chunk=?)'}
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN session_chunks c ON c.project_id=? AND c.session_id=? AND c.generation=?
        AND c.chunk_no=json_extract(j.value,'$.n') WHERE c.blob_key IS NOT json_extract(j.value,'$.k'))`,
    [...selection,session.projectId,session.sessionId,...(absent?[]:[session.projectId,session.sessionId,held.next_chunk]),
      batch.expectedChunks(registered), session.projectId, session.sessionId, doc.generation]);
    if (absent) before.push(db.prepare(`INSERT INTO session_documents(project_id,session_id,state,generation,updated_at)
      VALUES(?,?,'live',?,?)`).bind(session.projectId,session.sessionId,doc.generation,now));
    if (plannedConversion && !converting) before.push(...contentAssertion(db,
      `NOT EXISTS(SELECT 1 FROM transcript_publication WHERE project_id=? AND session_id=? AND published_offset>0)`,
      [session.projectId,session.sessionId]));
    if (converting && !absent) before.push(
      db.prepare(`INSERT OR IGNORE INTO retired_objects(project_id,session_id,blob_key,source_id,retired_at)
        SELECT project_id,session_id,blob_key,source_id,? FROM session_chunks WHERE project_id=? AND session_id=?`).bind(now,session.projectId,session.sessionId),
      ...BUILT.map(table => db.prepare(`DELETE FROM ${table} WHERE project_id=? AND session_id=?`).bind(session.projectId,session.sessionId)),
      db.prepare(`UPDATE session_documents SET generation=?,build=NULL,prompts=0,user_prompts=0,replies=0,tool_calls=0,failed_tools=0,plans=0,
        myco_calls=0,files_edited=0,paths_count=0,myco_build=0,paths_build=NULL,rollup_after=NULL,rollup_page=0,rollup_record=0,
        first_prompt=NULL,last_record_at=NULL,open_turn_key=NULL,next_chunk=0 WHERE project_id=? AND session_id=?`)
        .bind(doc.generation,session.projectId,session.sessionId),
    );
    return { before, after: [...(frontiers.length===0?[]:[publicationStatement(db,session.projectId,session.sessionId,doc.generation,now,frontiers)]), db.prepare(`UPDATE session_documents SET state='live',generation=?,restore_hold=NULL,due_at=0,build=?,${set.sql} WHERE project_id=? AND session_id=?`)
      .bind(doc.generation, doc.build, ...set.params, session.projectId, session.sessionId)] };
  });
}

/** The document side of a restore over this environment, as `core/backup.ts` takes it. */
export function restoreDocuments(env: Pick<ServerEnv, 'db' | 'blobs'>): RestoreDocuments {
  return {
    async plan(byTable) {
      const plan = await planDocumentRestore(env, byTable);
      return {
        summary: { convert: plan.convert.length, merge: plan.merge.length },
        apply: (now) => applyDocumentRestore(env, plan, now),
      };
    },
  };
}
