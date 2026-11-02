import { eventReferenceStatement } from '../db/event-references.js';
import { materialRecord } from '../content/document-records.js';
import { isTombstoned, sessionPresent } from '../core/tombstones.js';
import { decodePageChunk, type DecodedChunk, type DocRecord } from '../content/document.js';
import { registeredObjectKeySql } from '../core/blob-objects.js';
import { readStoredObject } from '../core/stored-object.js';
/**
 * Legacy backup content is converted directly into documents. A live document keeps its held records and admits
 * absent authoritative ids. Ambiguous legacy precedence refuses before writes. A converting session retains its
 * restore hold until its records, continuation, publication frontier and catalog become live in one transaction.
 */
import type { PreparedStatement, ServerEnv } from '../core/adapters.js';
import { sha256Hex, sha256HexOf } from '../hash.js';
import { contentAssertion } from '../core/registered-content.js';
import { SessionDocument } from '../content/session-pages.js';
import type { ChunkRow, PageRow } from '../content/document-reader.js';
import { DocumentBatch, directoryStatements, publicationStatement, type BatchDocument } from './document-batch.js';
import { legacyRecord } from './artifact-record.js';
import type { RestoreDocuments } from '../core/backup.js';

/** The legacy content tables a restore converts, in the order their records are placed: prompts before what names them. */
const CONTENT = [
  { table: 'prompt_batches', kind: 'prompt' },
  { table: 'responses', kind: 'reply' },
  { table: 'tool_calls', kind: 'tool' },
  { table: 'plans', kind: 'plan' },
] as const;
type ContentKind = (typeof CONTENT)[number]['kind'];
type Row = Record<string, unknown>;

export interface SessionRef { projectId: string; sessionId: string }
interface ArtifactDocument { records:DocRecord[]; states:Map<string,Row>; owners:DecodedChunk['owners']; frontiers:readonly Row[]; chunks:readonly Row[] }
type HeldRows = SessionRef & { snapshot?:ArtifactDocument; rows: { kind: ContentKind; row: Row }[]; transcripts?: readonly Row[]; checkpoints?: readonly Row[]; owners?: readonly Row[] };
export interface DocumentRestorePlan {
  convert: HeldRows[];
  merge: HeldRows[];
  refuse: SessionRef[];
}
/** How long a restore holds the sessions it converts from conversion while it writes their rows. */
export const RESTORE_CONVERSION_HOLD_MS = 15 * 60_000;
const PLAN_STALE = 'restore_plan_stale';
const PLAN_STALE_PATH = `$[${PLAN_STALE}]`;
export class RestorePlanStale extends Error {
  constructor() { super(`${PLAN_STALE}: a session this restore converts went live after the restore was planned; restore the artifact again`); }
}
const IN_PROGRESS = 'restore_in_progress';
const IN_PROGRESS_PATH = `$[${IN_PROGRESS}]`;
export class RestoreInProgress extends Error {
  constructor() { super(`${IN_PROGRESS}: another restore holds a session this restore converts; restore the artifact again once it finishes`); }
}
export class ArtifactPrecedenceAmbiguous extends Error {
  constructor(readonly sessions: readonly SessionRef[]) {
    super(`artifact_precedence_ambiguous: ${sessions.map((s) => s.sessionId).join(', ')}; restore these sessions through the staged restore`);
  }
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
  const snapshot:ArtifactDocument={records:[],states:new Map(),owners:null,frontiers:(tables.get('transcript_publication')??[]).filter(same),chunks};
  for(const row of chunks){
    if(row.kind==='body')continue;
    if(row.kind!=='page')throw new Error('artifact_document_chunk_kind');
    const chunk=await decodePageChunk(new Blob([await read(row)]).stream());
    for(const [key,state]of chunk.states)snapshot.states.set(key,state);
    if(chunk.owners!==null)snapshot.owners=chunk.owners;
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

/** Decides each session the artifact holds content for, reading the target before anything is written. */
export async function planDocumentRestore(env: Pick<ServerEnv, 'db' | 'blobs'>, byTable: ReadonlyMap<string, readonly Row[]>): Promise<DocumentRestorePlan> {
  const legacy = new Set((byTable.get('fact_classes') ?? []).filter((row) => row.class === 'legacy')
    .map((row) => JSON.stringify([row.project_id, row.table_name, row.record_id])));
  const artifactSessions = new Set((byTable.get('sessions') ?? []).map(row=>JSON.stringify([row.project_id,row.session_id])));
  const documented = new Set((byTable.get('session_documents') ?? []).map(row=>JSON.stringify([row.project_id,row.session_id])));
  const sessions = new Map<string, SessionRef & { rows: { kind: ContentKind; table: string; id: string; row: Row }[] }>();
  for (const { table, kind } of CONTENT) for (const row of byTable.get(table) ?? []) {
    if (typeof row.project_id !== 'string' || typeof row.session_id !== 'string') continue;
    const key = JSON.stringify([row.project_id, row.session_id]);
    if (kind==='plan' && documented.has(key)) continue;
    const held = sessions.get(key) ?? { projectId: row.project_id, sessionId: row.session_id, rows: [] };
    held.rows.push({ kind, table, id: materialRecord(kind,row).id, row });
    sessions.set(key, held);
  }
  const snapshots=new Map<string,ArtifactDocument>();
  for(const doc of byTable.get('session_documents')??[]){
    if(typeof doc.project_id!=='string'||typeof doc.session_id!=='string')throw new Error('artifact_document_identity');
    const key=JSON.stringify([doc.project_id,doc.session_id]);
    snapshots.set(key,await artifactDocument(env,byTable,doc));
    if(!sessions.has(key))sessions.set(key,{projectId:doc.project_id,sessionId:doc.session_id,rows:[]});
  }
  const plan: DocumentRestorePlan = { convert: [], merge: [], refuse: [] };
  for (const session of sessions.values()) {
    const ref = { projectId: session.projectId, sessionId: session.sessionId };
    if(await isTombstoned(env.db,ref.projectId,ref.sessionId))continue;
    const key=JSON.stringify([ref.projectId,ref.sessionId]);
    const snapshot=snapshots.get(key);
    if(!artifactSessions.has(key) && session.rows.some(({kind})=>kind==='plan') && !await sessionPresent(env.db,ref.projectId,ref.sessionId)) {
      session.rows=session.rows.filter(({kind})=>kind!=='plan');
      if(session.rows.length===0 && snapshot===undefined)continue;
    }
    const present = await documentIds(env, ref);
    if (present === null) { plan.convert.push({ ...ref, snapshot, rows: session.rows.map(({ kind, row }) => ({ kind, row })),
      transcripts: (byTable.get('transcripts') ?? []).filter(row=>row.project_id===ref.projectId&&row.session_id===ref.sessionId),
      checkpoints: byTable.get('transcript_parser_state_chunks') ?? [],
      owners: (byTable.get('prompt_key_owners') ?? []).filter(row=>row.project_id===ref.projectId&&row.session_id===ref.sessionId) }); continue; }
    const absent = session.rows.filter((held) => !present.has(`${held.kind}:${held.id}`));
    if (absent.some((held) => legacy.has(JSON.stringify([ref.projectId, held.table, held.id])))) plan.refuse.push(ref);
    else if (absent.length > 0 || snapshot!==undefined) plan.merge.push({ ...ref, snapshot, rows: absent.map(({ kind, row }) => ({ kind, row })) });
  }
  return plan;
}

/** Converts an artifact's saved continuation and frontier without replaying its already-restored records. */
async function artifactFrontiers(batch: DocumentBatch, session: HeldRows): Promise<Row[]> {
  const rows: Row[]=[];
  if(session.snapshot!==undefined){
    for(const [key,state]of session.snapshot.states)batch.writer.states.set(key,state);
    for(const [key,owner]of session.snapshot.owners??[])batch.writer.owners.set(key,owner);
    return session.snapshot.frontiers.map(row=>({t:row.transcript_id,o:row.published_offset,l:row.segment_lines,p:row.open_prompt_id,
      u:row.unfinished,r:row.reply_unfinished,a:row.reply_latest_at,ps:row.prompt_scheme,rs:row.record_scheme,s:row.state,f:row.failure,w:row.awaited_size,n:row.placed_records??null,d:row.placed_digest??null,diag:row.diagnostic??null}));
  }
  for(const row of session.transcripts ?? []){
    let context = typeof row.parser_context==='string' ? JSON.parse(row.parser_context) as Row : null;
    const state=context?.mycoParserState as Row | undefined;
    if(state?.chunked === true){
      const chunks=(session.checkpoints ?? []).filter(chunk=>chunk.project_id===session.projectId&&chunk.transcript_id===row.transcript_id&&chunk.cursor_offset===row.parsed_offset)
        .sort((a,b)=>Number(a.chunk_index)-Number(b.chunk_index));
      if(chunks.length===0||chunks.some((chunk,index)=>chunk.chunk_index!==index||chunk.chunk_count!==chunks.length||typeof chunk.payload!=='string')) throw new Error('artifact_checkpoint_incomplete');
      const encoded=chunks.map(chunk=>String(chunk.payload)).join('');
      if(await sha256Hex(encoded)!==state.digest)throw new Error('artifact_checkpoint_digest');
      context={...context,mycoParserState:JSON.parse(encoded)};
    }
    if(context!==null)batch.writer.states.set(String(row.transcript_id),context);
    const error=row.parse_error;
    rows.push({t:row.transcript_id,o:Number(row.parsed_offset??0),l:Number(row.parse_segment_lines??0),p:row.open_prompt_id??null,
      u:context?.mycoParserUnfinished===1?1:0,r:context?.mycoParserReplyUnfinished===1?1:0,a:context?.mycoParserReplyLatestAt??null,
      ps:row.prompt_identity_scheme??null,rs:row.record_identity_scheme??'legacy-session-v1',
      s:error==null?'active':error==='awaiting_bytes'?'awaiting':'failed',f:error==='awaiting_bytes'?null:error??null,w:row.parse_awaited_size??null});
  }
  for(const row of session.owners??[])batch.writer.owners.set(String(row.source_key),{thread:String(row.source_thread),record:String(row.source_record)});
  return rows;
}

/** The catalog tables a conversion fills before its flip. */
const BUILT = ['session_chunks', 'session_pages', 'session_sealed_records', 'session_prompts', 'session_paths', 'session_edit_paths', 'session_turn_entries', 'session_turn_totals', 'session_path_build', 'myco_tool_calls', 'transcript_publication'] as const;

/**
 * Restarts the conversion of every session the plan converts that `holder` may hold, in one batch that first refuses
 * when any of them is live or held by another restore whose hold has not run out. The chunks its conversion built are
 * held for release and its catalog rows and counters cleared. Fencing (`heldUntil` set) takes the hold for `holder`,
 * before which conversion passes the session by; applying (`heldUntil` null) restarts and releases only the sessions
 * `holder` holds.
 */
async function restartConversions(db: Pick<ServerEnv, 'db'>['db'], plan: DocumentRestorePlan, holder: string, now: number,
  heldUntil: number | null): Promise<void> {
  if (plan.convert.length === 0) return;
  const refs = JSON.stringify(plan.convert.map(({ projectId, sessionId }) => ({ projectId, sessionId })));
  const planned = `json_each(?) j JOIN session_documents d ON d.project_id = json_extract(j.value,'$.projectId') AND d.session_id = json_extract(j.value,'$.sessionId')`;
  const mine = heldUntil === null ? 'AND d.restore_hold = ?' : '';
  const own = heldUntil === null ? [holder] : [];
  const converting = `(project_id, session_id) IN (SELECT d.project_id, d.session_id FROM ${planned} AND d.state = 'convert' ${mine})`;
  try {
    await db.batch([
      db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM ${planned} AND d.state = 'live') THEN json_extract('[]', ?)
          WHEN EXISTS (SELECT 1 FROM ${planned} AND d.restore_hold IS NOT NULL AND d.restore_hold <> ? AND d.due_at > ?) THEN json_extract('[]', ?)
          ELSE 1 END AS admitted`)
        .bind(refs, PLAN_STALE_PATH, refs, holder, now, IN_PROGRESS_PATH),
      db.prepare(`INSERT OR IGNORE INTO retired_objects (project_id, session_id, blob_key, source_id, retired_at)
        SELECT project_id, session_id, blob_key, source_id, ? FROM session_chunks WHERE ${converting}`).bind(now, refs, ...own),
      ...BUILT.map((table) => db.prepare(`DELETE FROM ${table} WHERE ${converting}`).bind(refs, ...own)),
      heldUntil === null
        ? db.prepare(`UPDATE session_documents SET generation = NULL, build = NULL, due_at = NULL, restore_hold = NULL,
            prompts = 0, user_prompts = 0, replies = 0, tool_calls = 0, failed_tools = 0, plans = 0, myco_calls = 0, files_edited = 0, paths_count = 0, myco_build = 0, paths_build = NULL, rollup_after = NULL, rollup_page = 0, rollup_record = 0, first_prompt = NULL,
            last_record_at = NULL, open_turn_key = NULL, next_chunk = 0, updated_at = ? WHERE ${converting}`).bind(now, refs, holder)
        : db.prepare(`INSERT INTO session_documents (project_id, session_id, state, due_at, restore_hold, updated_at)
            SELECT json_extract(value,'$.projectId'), json_extract(value,'$.sessionId'), 'convert', ?, ?, ? FROM json_each(?) WHERE true
            ON CONFLICT (project_id, session_id) DO UPDATE SET state = 'convert', generation = NULL, build = NULL, due_at = excluded.due_at,
              restore_hold = excluded.restore_hold, prompts = 0, user_prompts = 0, replies = 0, tool_calls = 0, failed_tools = 0, plans = 0, myco_calls = 0, files_edited = 0, paths_count = 0, myco_build = 0, paths_build = NULL, rollup_after = NULL, rollup_page = 0, rollup_record = 0,
              first_prompt = NULL, last_record_at = NULL, open_turn_key = NULL, next_chunk = 0, updated_at = excluded.updated_at
              WHERE session_documents.state = 'convert'`).bind(heldUntil, holder, now, refs),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes(PLAN_STALE_PATH.slice(1))) throw new RestorePlanStale();
    if (error instanceof Error && error.message.includes(IN_PROGRESS_PATH.slice(1))) throw new RestoreInProgress();
    throw error;
  }
}

/** Before the restore's first write: re-checks the sessions it converts and holds them from conversion for `holder`. */
export async function fenceDocumentRestore(env: Pick<ServerEnv, 'db'>, plan: DocumentRestorePlan, holder: string, now: number): Promise<void> {
  await restartConversions(env.db, plan, holder, now, now + RESTORE_CONVERSION_HOLD_MS);
}

/**
 * Applies a plan once the artifact's rows are restored: each converting session `holder` holds restarts its conversion
 * again, so nothing a held pass adopted stands behind the restored rows, and its hold is released; merged rows join
 * their live document.
 */
export async function applyDocumentRestore(env: Pick<ServerEnv, 'db' | 'blobs'>, plan: DocumentRestorePlan, holder: string, now: number): Promise<void> {
  await restartConversions(env.db, plan, holder, now, now + RESTORE_CONVERSION_HOLD_MS);
  for(const session of [...plan.convert,...plan.merge])for(const chunk of session.snapshot?.chunks??[])await env.db.prepare(`INSERT OR IGNORE INTO retired_objects(project_id,session_id,blob_key,source_id,retired_at) VALUES(?,?,?,?,?)`)
    .bind(session.projectId,session.sessionId,chunk.blob_key,chunk.source_id,now).run();
  for (const session of plan.convert) await mergeSession(env, session, now, holder);
  for (const session of plan.merge) await mergeSession(env, session, now);
}

async function mergeSession(env: Pick<ServerEnv, 'db' | 'blobs'>, session: HeldRows, now: number, holder?: string): Promise<void> {
  const db = env.db;
  const state = holder === undefined ? `state='live'` : `state='convert' AND restore_hold=?`;
  const owner = holder === undefined ? [] : [holder];
  const [docs, chunks, pages] = await db.batch([
    db.prepare(`SELECT COALESCE(d.generation,1) generation, d.next_chunk, d.prompts, d.first_prompt, d.open_turn_key, d.build, s.created_by_token_id token_id,s.agent
      FROM session_documents d JOIN sessions s ON s.project_id = d.project_id AND s.session_id = d.session_id
      WHERE d.project_id = ?1 AND d.session_id = ?2 AND ${state}
        AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=d.project_id AND t.session_id=d.session_id)`).bind(session.projectId, session.sessionId, ...owner),
    ...directoryStatements(db, session.projectId, session.sessionId),
  ]);
  const doc = docs!.results[0] as (BatchDocument & { build: string | null; agent: string | null }) | undefined;
  if (doc === undefined) throw new RestorePlanStale();
  const generation = holder === undefined ? doc.generation : null;
  const batch = new DocumentBatch(env, session.projectId, session.sessionId, doc, chunks!.results as ChunkRow[], pages!.results as PageRow[]);
  await batch.open();
  const frontiers = holder===undefined&&session.snapshot!==undefined?[]:await artifactFrontiers(batch, session);
  const order = new Map(CONTENT.map(({ kind }, index) => [kind, index]));
  const rows = [...session.rows].sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || Number(a.row.created_at) - Number(b.row.created_at));
  const records:DocRecord[] = [...(session.snapshot?.records??[])];
  const build = doc.build === null ? {} : JSON.parse(doc.build) as { report?: { classes?: Record<string,number> } };
  const classes = { ...build.report?.classes };
  for (const { kind, row } of rows) {
    const restored = await legacyRecord(env, session.projectId, kind, row);
    records.push(restored.record);
    for (const name of restored.classes) classes[name] = (classes[name] ?? 0) + 1;
  }
  const diagnostics = Object.keys(classes).length === 0 ? doc.build : JSON.stringify({ ...build, report: { ...build.report, classes } });
  await batch.place(records, doc.agent);
  await batch.commit(batch.writer.changed, 'live', now, (version) => ({
    sql: `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND ${state} AND generation IS ?)
      AND EXISTS (SELECT 1 FROM retired_objects WHERE project_id=? AND session_id=? AND blob_key=? AND source_id=?)`,
    params: [session.projectId, session.sessionId, ...owner, generation, session.projectId, session.sessionId, version.key, version.sourceId],
  }), (registered) => {
    const set = batch.documentSet(now);
    const before: PreparedStatement[] = contentAssertion(db, `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=?
        AND ${state} AND generation IS ? AND next_chunk=?
        AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.project_id=session_documents.project_id AND t.session_id=session_documents.session_id))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN session_chunks c ON c.project_id=? AND c.session_id=? AND c.generation=?
        AND c.chunk_no=json_extract(j.value,'$.n') WHERE c.blob_key IS NOT json_extract(j.value,'$.k'))`,
    [session.projectId, session.sessionId, ...owner, generation, doc.next_chunk, batch.expectedChunks(registered), session.projectId, session.sessionId, doc.generation]);
    return { before, after: [...(frontiers.length===0?[]:[publicationStatement(db,session.projectId,session.sessionId,doc.generation,now,frontiers)]), db.prepare(`UPDATE session_documents SET state='live',generation=?,restore_hold=NULL,due_at=0,build=?,${set.sql} WHERE project_id=? AND session_id=?`)
      .bind(doc.generation, diagnostics, ...set.params, session.projectId, session.sessionId)] };
  });
}

/** The document side of a restore over this environment, as `core/backup.ts` takes it. */
export function restoreDocuments(env: Pick<ServerEnv, 'db' | 'blobs'>): RestoreDocuments {
  return {
    async plan(byTable) {
      const plan = await planDocumentRestore(env, byTable);
      const holder = crypto.randomUUID();
      return {
        summary: { convert: plan.convert.length, merge: plan.merge.length, records: plan.merge.reduce((sum, s) => sum + s.rows.length, 0),
          refuse: plan.refuse.map((s) => s.sessionId) },
        fence: (now) => fenceDocumentRestore(env, plan, holder, now),
        apply: (now) => applyDocumentRestore(env, plan, holder, now),
      };
    },
  };
}


/** Legacy artifact references fill only absent values of events the destination holds. */
export async function restoreLegacyEventReferences(db: ServerEnv['db'], tables: ReadonlyMap<string, readonly Row[]>): Promise<void> {
  for(const [table,id,blob] of [['prompt_batches','prompt_id','blob_key'],['responses','response_id','blob_key'],['tool_calls','tool_call_id','input_blob_key']] as const) {
    for(const row of tables.get(table)??[]) {
      if(typeof row.event_id!=='string')continue;
      await eventReferenceStatement(db,{project_id:row.project_id,event_id:row.event_id,session_id:row.session_id,
        record_id:row[id],blob:row[blob],output_blob:row.output_blob_key},true).all();
    }
  }
}
