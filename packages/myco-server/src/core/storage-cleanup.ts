import type { PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';
import { eventArchiveStatements, prepareArchive, prepareArchiveStep, archiveCheckpointClearStatement,
  archiveAssertions, CONTENT_SLICE_BYTES, type PreparedArchive, type ContentRow } from './event-content.js';
import { contentAssertion } from './registered-content.js';
import { measuredContentEnv, remainingContentBudget } from './content-budget.js';
import { emit } from '../telemetry.js';
import { TOOL_INPUT_PREVIEW_BYTES } from './tool-input.js';
import { utf8 } from '../hash.js';

export const STORAGE_CLEANUP_ROWS = 20;
export const STORAGE_CLEANUP_PAGE_BYTES = 1024 * 1024;
const INPUT_LIMIT = TOOL_INPUT_PREVIEW_BYTES;
const ROW_RESERVE = 42;
const BLOB_RESERVE = 8;

interface CleanupState {
  phase:number;cursor_project:string;cursor_id:string;revision:number;complete:number;paused:number;
}
type Candidate = {project_id:string;resource_id:string;resource_kind:'event'|'tool-input'};
const stateGuard = (state:CleanupState) => ({
  sql:'EXISTS (SELECT 1 FROM storage_cleanup_state WHERE id=1 AND phase=? AND cursor_project=? AND cursor_id=? AND revision=? AND paused=0)',
  params:[state.phase,state.cursor_project,state.cursor_id,state.revision],
});

const readState = (db:RelationalStore) => db.prepare('SELECT phase,cursor_project,cursor_id,revision,complete,paused FROM storage_cleanup_state WHERE id=1').first<CleanupState>();

/** A primary-key page bounds candidates examined, independently of body size or eligibility. */
async function identities(db:RelationalStore,state:CleanupState):Promise<Candidate[]> {
  if(state.phase===2 || state.phase===4) return (await db.prepare(`SELECT project_id,resource_id,resource_kind
    FROM storage_cleanup_queue ORDER BY project_id,resource_kind,resource_id LIMIT ?`).bind(STORAGE_CLEANUP_ROWS).all<Candidate>()).results;
  const input=state.phase===0;
  const table=input?'tool_calls':state.phase===3?'event_content_refs':'events';
  const id=input?'tool_call_id':'event_id';
  return (await db.prepare(`SELECT project_id,${id} AS resource_id,'${input?'tool-input':'event'}' AS resource_kind FROM ${table}
    WHERE (project_id,${id})>(?,?) ORDER BY project_id,${id} LIMIT ?`)
    .bind(state.cursor_project,state.cursor_id,STORAGE_CLEANUP_ROWS).all<Candidate>()).results;
}

/** Metadata is read first; large bodies travel only as bounded UTF-8 slices. */
async function candidate(db:RelationalStore,id:Candidate,retention=false):Promise<ContentRow|null> {
  const input=id.resource_kind==='tool-input';
  const fields=input?'t.tool_call_id AS resource_id,t.event_id,t.session_id,t.token_id,t.content_revision,t.received_at,length(CAST(t.input AS BLOB)) AS bytes'
    :'e.event_id AS resource_id,e.event_id,e.session_id,e.token_id,e.content_revision,e.received_at,length(CAST(e.payload AS BLOB)) AS bytes';
  return db.prepare(`SELECT ${input?'t':'e'}.project_id,${fields},e.envelope_hash
    FROM ${input?'tool_calls t JOIN events e ON e.project_id=t.project_id AND e.event_id=t.event_id':'events e'}
    WHERE ${input?'t':'e'}.project_id=? AND ${input?'t.tool_call_id':'e.event_id'}=?
      AND ${input?`t.input IS NOT NULL AND length(CAST(t.input AS BLOB))>${INPUT_LIMIT}`:
        `e.payload_format='inline'${retention?'':" AND (e.producer_adapter='transcript-parse' OR e.channel='import') AND e.kind IN ('prompt','response','tool.use','tool.failure','plan.snapshot')"}`}`)
    .bind(id.project_id,id.resource_id).first<ContentRow>();
}

export { candidate as cleanupCandidate };

/** Exact tool input, proof and display prefix publish in the same source-revision transaction. */
export async function inputArchiveStatements(env:Pick<ServerEnv,'db'|'blobs'>,row:ContentRow,now:number,
  prepared?:PreparedArchive & {preview:string}):Promise<PreparedStatement[]> {
  const archive=prepared??await prepareArchive(env,'tool-input',row,now);
  const db=env.db;
  return [
    ...archiveAssertions(db,archive),
    ...contentAssertion(db,`EXISTS (SELECT 1 FROM tool_calls t JOIN events e
      ON e.project_id=t.project_id AND e.event_id=t.event_id AND e.session_id=t.session_id
      WHERE t.project_id=? AND t.tool_call_id=? AND t.content_revision=? AND t.event_id=?
        AND t.session_id=? AND e.envelope_hash=?)`,
      [row.project_id,row.resource_id,row.content_revision,row.event_id,row.session_id,row.envelope_hash]),
    db.prepare(`INSERT INTO processed_resources(project_id,kind,resource_id,blob_key,source_token_id,event_id)
      VALUES(?,'tool-input',?,?,?,?) ON CONFLICT DO NOTHING`).bind(row.project_id,row.resource_id,archive.body.key,row.token_id,archive.source.eventId),
    db.prepare(`UPDATE tool_calls SET input=?,input_blob_key=?,input_bytes=? WHERE project_id=? AND tool_call_id=? AND content_revision=?`)
      .bind(archive.preview,archive.body.key,row.bytes,row.project_id,row.resource_id,row.content_revision),
    ...contentAssertion(db,`EXISTS (SELECT 1 FROM tool_calls t JOIN processed_resources p
      ON p.project_id=t.project_id AND p.kind='tool-input' AND p.resource_id=t.tool_call_id AND p.blob_key=t.input_blob_key
      WHERE t.project_id=? AND t.tool_call_id=? AND t.input_blob_key=? AND t.input_bytes=?
        AND p.event_id=? AND p.source_token_id=?)`,
      [row.project_id,row.resource_id,archive.body.key,row.bytes,archive.source.eventId,archive.source.tokenId]),
    archiveCheckpointClearStatement(db,'tool-input',row),
  ];
}

/** Commits source decisions, exact clear and sweep progress together. */
async function commitPage(db:RelationalStore,state:CleanupState,ids:Candidate[],writes:PreparedStatement[],now:number,converted=0,cleared=0,advancePhase=false):Promise<void> {
  const guard=stateGuard(state);
  const queue=state.phase===2 || state.phase===4;
  const last=ids.at(-1);
  const next=advancePhase?state.phase===2?3:state.phase+1:state.phase;
  await db.batch([
    ...contentAssertion(db,guard.sql,guard.params),...writes,
    ...ids.map(id=>db.prepare('DELETE FROM storage_cleanup_queue WHERE project_id=? AND resource_kind=? AND resource_id=?')
      .bind(id.project_id,id.resource_kind,id.resource_id)),
    db.prepare(`UPDATE storage_cleanup_state SET phase=?,cursor_project=?,cursor_id=?,revision=revision+1,
      complete=?,converted_rows=converted_rows+?,cleared_bytes=cleared_bytes+?,updated_at=?,failure=NULL
      WHERE id=1 AND phase=? AND cursor_project=? AND cursor_id=? AND revision=? AND paused=0`)
      .bind(next,advancePhase?'':queue?state.cursor_project:last?.project_id??state.cursor_project,
        advancePhase?'':queue?state.cursor_id:last?.resource_id??state.cursor_id,next===4?1:0,converted,cleared,now,...guard.params),
  ]);
}

/** Bounded, time-admitted archive-and-clear work follows capture and parsing. */
export async function storageCleanup(env:Pick<ServerEnv,'db'|'blobs'>,now:number,options:{clock?:()=>number;statements?:number;blobCalls?:number;wallMs?:number}={}):Promise<{changed:number;more:boolean}> {
  const clock=options.clock??Date.now;
  const remaining=remainingContentBudget(env.db);
  const started=clock(),deadline=started+(options.wallMs??remaining.wallMs);
  const limits={statements:options.statements??remaining.statements,blobCalls:options.blobCalls??remaining.blobCalls};
  const measured=measuredContentEnv(env,limits);
  let changed=0,longest=0;
  for(;;) {
    if(clock()+longest>=deadline || measured.usage.statements+ROW_RESERVE>limits.statements || measured.usage.blobCalls+BLOB_RESERVE>limits.blobCalls) break;
    const start=clock();
    const state=await readState(measured.env.db);
    if(state===null) throw new Error('storage_cleanup_state_missing');
    if(state.paused===1) return {changed,more:false};
    const ids=await identities(measured.env.db,state);
    if(ids.length===0) {
      if(state.phase===4) break;
      await commitPage(measured.env.db,state,[],[],now,0,0,true);
      continue;
    }
    if(state.phase===3) {
      for(const id of ids) {
        const held=await measured.env.db.prepare(`SELECT 1 AS ok FROM event_content_refs r JOIN events e
          ON e.project_id=r.project_id AND e.event_id=r.event_id AND e.payload_format='archived' AND e.envelope_hash=r.source_envelope_hash
          JOIN blobs b ON b.project_id=r.project_id AND b.key=r.archive_key AND b.size=r.size
          JOIN blobs rb ON rb.project_id=r.project_id AND rb.key=r.receipt_key
          WHERE r.project_id=? AND r.event_id=? AND r.version=1 AND r.digest=r.archive_key`)
          .bind(id.project_id,id.resource_id).first();
        if(held===null) throw new Error('storage_cleanup_closure_invalid');
      }
      await commitPage(measured.env.db,state,ids,[],now);
      longest=Math.max(longest,clock()-start);continue;
    }
    const skipped:Candidate[]=[];
    let converted=false;
    for(const id of ids) {
      const row=await candidate(measured.env.db,id);
      if(row===null) { skipped.push(id);continue; }
      const scan=row.bytes>STORAGE_CLEANUP_PAGE_BYTES ? await measured.env.db.prepare(`SELECT scanned_bytes FROM content_scan_checkpoints
        WHERE project_id=? AND source_kind=? AND resource_id=? AND content_revision=? AND envelope_hash=?`)
        .bind(row.project_id,id.resource_kind,row.resource_id,row.content_revision,row.envelope_hash).first<{scanned_bytes:number}>():null;
      const scanning=row.bytes>STORAGE_CLEANUP_PAGE_BYTES && scan?.scanned_bytes!==row.bytes;
      const reserve=(scanning?12:ROW_RESERVE+(row.bytes>STORAGE_CLEANUP_PAGE_BYTES?1:2)*Math.ceil(row.bytes/CONTENT_SLICE_BYTES))+skipped.length;
      if(measured.usage.statements+reserve>limits.statements) break;
      const step=await prepareArchiveStep(measured.env,id.resource_kind,row,now);
      if(step.status==='pending') {
        if(skipped.length>0) await commitPage(measured.env.db,state,skipped,[],now);
        emit({kind:'storage_content_cleanup',rows:changed,...measured.usage,elapsed_ms:clock()-started,more:true});
        return {changed,more:true};
      }
      const writes=id.resource_kind==='event'
        ? eventArchiveStatements(measured.env.db,row,step.archive)
        : await inputArchiveStatements(measured.env,row,now,step.archive);
      if(clock()>=deadline) return {changed,more:true};
      const cleared=row.bytes-(id.resource_kind==='event'?2:utf8(step.archive.preview).byteLength);
      await commitPage(measured.env.db,state,[...skipped,id],writes,now,1,cleared);
      changed++;converted=true;break;
    }
    if(!converted) {
      if(skipped.length===0) break;
      await commitPage(measured.env.db,state,skipped,[],now);
    }
    longest=Math.max(longest,clock()-start);
  }
  const more=await storageCleanupPending(measured.env.db);
  emit({kind:'storage_content_cleanup',rows:changed,...measured.usage,elapsed_ms:clock()-started,more});
  return {changed,more};
}

export async function storageCleanupPending(db:RelationalStore):Promise<boolean> {
  const state=await readState(db);
  if(state===null) throw new Error('storage_cleanup_state_missing');
  if(state.paused===1) return false;
  if(state.complete===0) return await db.prepare(`SELECT 1 AS pending WHERE
    EXISTS (SELECT 1 FROM events LIMIT 1) OR EXISTS (SELECT 1 FROM tool_calls LIMIT 1)
    OR EXISTS (SELECT 1 FROM event_content_refs LIMIT 1) OR EXISTS (SELECT 1 FROM storage_cleanup_queue LIMIT 1)`).first()!==null;
  return await db.prepare('SELECT 1 AS pending FROM storage_cleanup_queue LIMIT 1').first()!==null;
}
