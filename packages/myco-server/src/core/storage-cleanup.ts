import type { PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';
import { prepareArchive,prepareArchiveStep,type PreparedArchive,type ContentRow } from './event-content.js';
import { bundleArchiveStatements,prepareArchiveBundle,ARCHIVE_BUNDLE_BYTES,readBundleEntry,type BundleItem } from './archive-bundle.js';
import { contentAssertion } from './registered-content.js';
import { measuredContentEnv, remainingContentBudget } from './content-budget.js';
import { effectiveRawOwnerSql } from './raw-claims.js';
import { emit } from '../telemetry.js';
import { TOOL_INPUT_PREVIEW_BYTES } from './tool-input.js';
import { utf8 } from '../hash.js';

export const STORAGE_CLEANUP_ROWS = 20;
export const STORAGE_CLEANUP_PAGE_BYTES = ARCHIVE_BUNDLE_BYTES;
const ROW_RESERVE = 42;
const BLOB_RESERVE = 8;
interface CleanupState {
  phase:number;cursor_project:string;cursor_id:string;cursor_session:string;cursor_created:number;cursor_rowid:number;
  revision:number;complete:number;paused:number;
}
type Candidate={project_id:string;resource_id:string;resource_kind:'event'|'tool-input';
  session_id?:string;created_at?:number;source_rowid?:number};
const stateGuard=(state:CleanupState)=>({
  sql:`EXISTS (SELECT 1 FROM storage_cleanup_state WHERE id=1 AND phase=? AND cursor_project=? AND cursor_id=?
    AND cursor_session=? AND cursor_created=? AND cursor_rowid=? AND revision=? AND paused=0)`,
  params:[state.phase,state.cursor_project,state.cursor_id,state.cursor_session,state.cursor_created,state.cursor_rowid,state.revision],
});
const readState=(db:RelationalStore)=>db.prepare('SELECT * FROM storage_cleanup_state WHERE id=1').first<CleanupState>();

/** Existing session indexes page identities before body eligibility is inspected. */
async function identities(db:RelationalStore,state:CleanupState):Promise<Candidate[]> {
  if(state.phase===2||state.phase===4){
    const queued=(await db.prepare(`SELECT project_id,resource_id,resource_kind FROM storage_cleanup_queue
      ORDER BY project_id,resource_kind,resource_id LIMIT ?`).bind(STORAGE_CLEANUP_ROWS).all<Candidate>()).results;
    const first=queued[0];
    if(first?.resource_kind==='tool-input'){
      const anchor=await db.prepare('SELECT session_id,created_at,rowid AS source_rowid FROM tool_calls WHERE project_id=? AND tool_call_id=?')
        .bind(first.project_id,first.resource_id).first<{session_id:string;created_at:number;source_rowid:number}>();
      if(anchor){
        const prior=(await db.prepare(`SELECT project_id,tool_call_id AS resource_id,'tool-input' AS resource_kind
          FROM tool_calls INDEXED BY idx_tool_calls_session WHERE project_id=? AND session_id=?
            AND (created_at,rowid)<(?,?) ORDER BY created_at DESC,rowid DESC LIMIT 1`)
          .bind(first.project_id,anchor.session_id,anchor.created_at,anchor.source_rowid).all<Candidate>()).results[0];
        const priorRow=prior?await candidate(db,prior):null;
        const anchorRow=priorRow?await candidate(db,first):null;
        const compactPrior=priorRow&&anchorRow&&priorRow.input_bundle_id!==null&&priorRow.input_bundle_id!==undefined
          &&sameEvidence(priorRow,anchorRow)&&priorRow.bytes+anchorRow.bytes<=STORAGE_CLEANUP_PAGE_BYTES?prior:null;
        const nearby=(await db.prepare(`SELECT project_id,tool_call_id AS resource_id,'tool-input' AS resource_kind
          FROM tool_calls INDEXED BY idx_tool_calls_session WHERE project_id=? AND session_id=?
            AND (created_at,rowid)>=(?,?) ORDER BY created_at,rowid LIMIT ?`)
          .bind(first.project_id,anchor.session_id,anchor.created_at,anchor.source_rowid,
            STORAGE_CLEANUP_ROWS-(compactPrior?1:0)).all<Candidate>()).results;
        return compactPrior?[compactPrior,...nearby]:nearby;
      }
    }
    return queued;
  }
  const input=state.phase===0;const table=input?'tool_calls':'events';const id=input?'tool_call_id':'event_id';
  return (await db.prepare(`SELECT rowid AS source_rowid,project_id,${id} AS resource_id,session_id,created_at,
    '${input?'tool-input':'event'}' AS resource_kind FROM ${table} INDEXED BY ${input?'idx_tool_calls_session':'idx_events_session'}
    WHERE (project_id,session_id,created_at,rowid)>(?,?,?,?) ORDER BY project_id,session_id,created_at,rowid LIMIT ?`)
    .bind(state.cursor_project,state.cursor_session,state.cursor_created,state.cursor_rowid,STORAGE_CLEANUP_ROWS).all<Candidate>()).results;
}

/** Metadata is read first; exact UTF-8 bodies use a bounded page or checkpointed slices. */
async function candidate(db:RelationalStore,id:Candidate,retention=false):Promise<ContentRow|null> {
  const input=id.resource_kind==='tool-input';
  const fields=input?'t.tool_call_id AS resource_id,t.event_id,t.session_id,t.token_id,t.content_revision,t.received_at,CASE WHEN t.input_bundle_id IS NULL THEN length(CAST(t.input AS BLOB)) ELSE t.input_bytes END AS bytes,t.input_bundle_id,t.input_bundle_entry,length(CAST(t.input AS BLOB)) AS input_preview_bytes,a.archive_key AS input_archive_key,a.receipt_key AS input_receipt_key'
    :'e.event_id AS resource_id,e.event_id,e.session_id,e.token_id,e.content_revision,e.received_at,length(CAST(e.payload AS BLOB)) AS bytes';
  return db.prepare(`SELECT ${input?'t':'e'}.project_id,${fields},e.envelope_hash,COALESCE(e.raw_revision,0) AS raw_revision,
    c.provenance AS raw_provenance,${effectiveRawOwnerSql('c.owner_member_id','c.provenance','e.raw_revision')} AS raw_owner
    FROM ${input?'tool_calls t JOIN events e ON e.project_id=t.project_id AND e.event_id=t.event_id':'events e'}
    ${input?'LEFT JOIN archive_bundles a ON a.project_id=t.project_id AND a.id=t.input_bundle_id':''}
    LEFT JOIN raw_credentials c ON c.token_id=${input?'t':'e'}.token_id
    WHERE ${input?'t':'e'}.project_id=? AND ${input?'t.tool_call_id':'e.event_id'}=?
      AND ${input?`t.input IS NOT NULL AND ((t.input_bundle_id IS NULL AND length(CAST(t.input AS BLOB))>${TOOL_INPUT_PREVIEW_BYTES}) OR (t.input_bundle_id IS NOT NULL AND a.entry_count=1 AND t.input_bytes<=${STORAGE_CLEANUP_PAGE_BYTES}))`:
        `e.payload_format='inline'${retention?'':" AND (e.producer_adapter='transcript-parse' OR e.channel='import') AND e.kind IN ('prompt','response','tool.use','tool.failure','plan.snapshot')"}`}`)
    .bind(id.project_id,id.resource_id).first<ContentRow>();
}
export {candidate as cleanupCandidate};

export async function inputArchiveStatements(env:Pick<ServerEnv,'db'|'blobs'>,row:ContentRow,now:number,
  prepared?:PreparedArchive & {preview:string}):Promise<PreparedStatement[]> {
  const archive=prepared??await prepareArchive(env,'tool-input',row,now);
  return bundleArchiveStatements(env.db,archive.bundle);
}

/** Clear, compact representation, queue release and sweep progress share one commit. */
async function commitPage(db:RelationalStore,state:CleanupState,ids:Candidate[],writes:PreparedStatement[],now:number,
  converted=0,cleared=0,metadata=0,advancePhase=false):Promise<void>{
  const guard=stateGuard(state);const queue=state.phase===2||state.phase===4;const last=ids.at(-1);
  const next=advancePhase?state.phase+1:state.phase;
  await db.batch([
    ...contentAssertion(db,guard.sql,guard.params),...writes,
    db.prepare(`DELETE FROM storage_cleanup_queue WHERE EXISTS (SELECT 1 FROM json_each(?) j
      WHERE project_id=json_extract(j.value,'$.project_id') AND resource_kind=json_extract(j.value,'$.resource_kind')
        AND resource_id=json_extract(j.value,'$.resource_id'))`).bind(JSON.stringify(ids)),
    db.prepare(`UPDATE storage_cleanup_state SET phase=?,cursor_project=?,cursor_id=?,cursor_session=?,cursor_created=?,cursor_rowid=?,
      revision=revision+1,complete=?,converted_rows=converted_rows+?,cleared_bytes=cleared_bytes+?,
      metadata_added_bytes=metadata_added_bytes+?,updated_at=?,failure=NULL WHERE id=1 AND ${guard.sql}`)
      .bind(next,advancePhase?'':queue?state.cursor_project:last?.project_id??state.cursor_project,
        advancePhase?'':queue?state.cursor_id:last?.resource_id??state.cursor_id,
        advancePhase?'':queue?state.cursor_session:last?.session_id??state.cursor_session,
        advancePhase?-1:queue?state.cursor_created:last?.created_at??state.cursor_created,
        advancePhase?-1:queue?state.cursor_rowid:last?.source_rowid??state.cursor_rowid,
        next===4?1:0,converted,cleared,metadata,now,...guard.params),
  ]);
}
const sameEvidence=(a:ContentRow,b:ContentRow)=>a.project_id===b.project_id&&a.session_id===b.session_id
  &&a.token_id===b.token_id&&a.raw_owner===b.raw_owner&&a.raw_provenance===b.raw_provenance;

/** Capture and parsing precede bounded session-page archive-and-clear work. */
export async function storageCleanup(env:Pick<ServerEnv,'db'|'blobs'>,now:number,
  options:{clock?:()=>number;statements?:number;blobCalls?:number;wallMs?:number}={}):Promise<{changed:number;more:boolean}>{
  const clock=options.clock??Date.now;const remaining=remainingContentBudget(env.db);
  const started=clock(),deadline=started+(options.wallMs??remaining.wallMs);
  const limits={statements:options.statements??remaining.statements,blobCalls:options.blobCalls??remaining.blobCalls};
  const measured=measuredContentEnv(env,limits);let changed=0,longest=0,clearedBytes=0,metadataAdded=0;
  for(;;){
    if(clock()+longest>=deadline||measured.usage.statements+ROW_RESERVE>limits.statements||measured.usage.blobCalls+BLOB_RESERVE>limits.blobCalls)break;
    const start=clock();const state=await readState(measured.env.db);if(!state)throw new Error('storage_cleanup_state_missing');
    if(state.paused===1)return {changed,more:false};
    if(state.phase===3){await commitPage(measured.env.db,state,[],[],now,0,0,0,true);continue;}
    const ids=await identities(measured.env.db,state);
    if(ids.length===0){if(state.phase===4)break;await commitPage(measured.env.db,state,[],[],now,0,0,0,true);continue;}
    const consumed:Candidate[]=[];const items:BundleItem[]=[];let bytes=0;
    for(const id of ids){
      if(clock()>=deadline||measured.usage.statements+ROW_RESERVE+items.length*3>limits.statements
        ||measured.usage.blobCalls+BLOB_RESERVE>limits.blobCalls)break;
      const row=await candidate(measured.env.db,id);
      if(!row){consumed.push(id);continue;}
      if(items.length&&( !sameEvidence(items[0]!.row,row)||bytes+row.bytes>STORAGE_CLEANUP_PAGE_BYTES))break;
      if(row.bytes>STORAGE_CLEANUP_PAGE_BYTES){
        if(items.length)break;
        const scans=await measured.env.db.prepare(`SELECT scanned_bytes FROM content_scan_checkpoints
          WHERE project_id=? AND source_kind=? AND resource_id=? AND content_revision=? AND envelope_hash=?`)
          .bind(row.project_id,id.resource_kind,row.resource_id,row.content_revision,row.envelope_hash).first<{scanned_bytes:number}>();
        if(scans?.scanned_bytes===row.bytes&&measured.usage.statements+ROW_RESERVE+Math.ceil(row.bytes/STORAGE_CLEANUP_PAGE_BYTES)>limits.statements)break;
        const step=await prepareArchiveStep(measured.env,id.resource_kind,row,now);
        if(step.status==='pending'){if(consumed.length)await commitPage(measured.env.db,state,consumed,[],now);return {changed,more:true};}
        if(clock()>=deadline)return {changed,more:true};
        const cleared=row.bytes-(id.resource_kind==='event'?2:utf8(step.archive.preview).length);
        await commitPage(measured.env.db,state,[...consumed,id],bundleArchiveStatements(measured.env.db,step.archive.bundle),now,
          1,cleared,step.archive.bundle.metadataBytes);
        changed++;clearedBytes+=cleared;metadataAdded+=step.archive.bundle.metadataBytes;consumed.length=0;break;
      }
      consumed.push(id);items.push({kind:id.resource_kind,row,text:row.input_bundle_id!==null&&row.input_bundle_id!==undefined
        ?await readBundleEntry(measured.env,{projectId:row.project_id,bundleId:row.input_bundle_id,entry:row.input_bundle_entry!,
          kind:'tool-input',resourceId:row.resource_id,tokenId:row.token_id}):undefined});bytes+=row.bytes;
    }
    if(items.length===1&&items[0]!.row.input_bundle_id!==null&&items[0]!.row.input_bundle_id!==undefined){
      await commitPage(measured.env.db,state,consumed,[],now);longest=Math.max(longest,clock()-start);continue;
    }
    if(items.length){
      if(clock()>=deadline)return {changed,more:true};
      const bundle=await prepareArchiveBundle(measured.env,items,now);
      if(clock()>=deadline)return {changed,more:true};
      const cleared=bundle.items.reduce((sum,item)=>sum+(item.row.input_bundle_id!==null&&item.row.input_bundle_id!==undefined?0:item.row.bytes-(item.kind==='event'?2:utf8(item.preview).length)),0);
      await commitPage(measured.env.db,state,consumed,bundleArchiveStatements(measured.env.db,bundle),now,
        items.length,cleared,bundle.metadataBytes);
      changed+=items.length;clearedBytes+=cleared;metadataAdded+=bundle.metadataBytes;
    }else if(consumed.length)await commitPage(measured.env.db,state,consumed,[],now);
    else if(clock()===start)break;
    longest=Math.max(longest,clock()-start);
  }
  const more=await storageCleanupPending(measured.env.db);
  emit({kind:'storage_content_cleanup',rows:changed,cleared_bytes:clearedBytes,metadata_added_bytes:metadataAdded,
    ...measured.usage,elapsed_ms:clock()-started,more});
  return {changed,more};
}
export async function storageCleanupPending(db:RelationalStore):Promise<boolean>{
  const state=await readState(db);if(!state)throw new Error('storage_cleanup_state_missing');
  if(state.paused===1)return false;
  if(state.complete===0)return await db.prepare(`SELECT 1 AS pending WHERE EXISTS(SELECT 1 FROM events LIMIT 1)
    OR EXISTS(SELECT 1 FROM tool_calls LIMIT 1) OR EXISTS(SELECT 1 FROM storage_cleanup_queue LIMIT 1)`).first()!==null;
  return await db.prepare('SELECT 1 AS pending FROM storage_cleanup_queue LIMIT 1').first()!==null;
}
