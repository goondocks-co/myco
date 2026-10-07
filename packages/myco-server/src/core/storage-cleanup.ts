import type { PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';
import { prepareArchive,prepareArchiveStep,type PreparedArchive,type ContentRow } from './event-content.js';
import { bundleArchiveStatements,discardArchiveBundle,prepareArchiveBundle,ARCHIVE_BUNDLE_BYTES,ARCHIVE_BUNDLE_ENTRIES,projectedBundleMetadata,type BundleItem } from './archive-bundle.js';
import { contentAssertion } from './registered-content.js';
import { measuredContentEnv, remainingContentBudget } from './content-budget.js';
import { effectiveRawOwnerSql } from './raw-claims.js';
import { emit } from '../telemetry.js';
import { TOOL_INPUT_PREVIEW_BYTES } from './tool-input.js';
import { utf8 } from '../hash.js';

export const STORAGE_CLEANUP_ROWS = 100;
export const STORAGE_CLEANUP_TARGET_BYTES = 64 * 1024;
export const STORAGE_CLEANUP_GAIN_MARGIN = 0.2;
export const STORAGE_CLEANUP_PAGE_BYTES = ARCHIVE_BUNDLE_BYTES;
const ROW_RESERVE = 48;
const PENDING_STATUS_RESERVE = 2;
const STATEMENT_RESERVE = ROW_RESERVE + PENDING_STATUS_RESERVE;
const BLOB_RESERVE = 8;
export interface CleanupState {
  phase:number;cursor_project:string;cursor_id:string;cursor_session:string;cursor_created:number;cursor_rowid:number;
  revision:number;complete:number;paused:number;
  converted_rows:number;cleared_bytes:number;metadata_added_bytes:number;updated_at:number;failure:string|null;
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
async function identities(db:RelationalStore,state:CleanupState,after?:Candidate):Promise<Candidate[]> {
  if(state.phase===2||state.phase===4){
    return (await db.prepare(`SELECT project_id,session_id,resource_id,resource_kind FROM storage_cleanup_queue
      INDEXED BY idx_storage_cleanup_queue_packing WHERE (project_id,session_id,resource_kind,resource_id)>(?,?,?,?)
      ORDER BY project_id,session_id,resource_kind,resource_id LIMIT ?`)
      .bind(after?.project_id??'',after?.session_id??'',after?.resource_kind??'',after?.resource_id??'',STORAGE_CLEANUP_ROWS).all<Candidate>()).results;
  }
  const input=state.phase===0;const table=input?'tool_calls':'events';const id=input?'tool_call_id':'event_id';
  return (await db.prepare(`SELECT rowid AS source_rowid,project_id,${id} AS resource_id,session_id,created_at,
    '${input?'tool-input':'event'}' AS resource_kind FROM ${table} INDEXED BY ${input?'idx_tool_calls_session':'idx_events_session'}
    WHERE (project_id,session_id,created_at,rowid)>(?,?,?,?) ORDER BY project_id,session_id,created_at,rowid LIMIT ?`)
    .bind(state.cursor_project,state.cursor_session,state.cursor_created,state.cursor_rowid,STORAGE_CLEANUP_ROWS).all<Candidate>()).results;
}

/** Metadata is read first; exact UTF-8 bodies use a bounded page or checkpointed slices. */
async function candidates(db:RelationalStore,ids:Candidate[],retention=false):Promise<Map<string,ContentRow>> {
  const rows=new Map<string,ContentRow>();
  for(const kind of ['tool-input','event'] as const){
    const selected=ids.filter(id=>id.resource_kind===kind);if(selected.length===0)continue;
    const input=kind==='tool-input';
    const fields=input?'t.tool_call_id AS resource_id,t.event_id,t.session_id,t.token_id,t.content_revision,t.received_at,length(CAST(t.input AS BLOB)) AS bytes,t.input_bundle_id'
      :'e.event_id AS resource_id,e.event_id,e.session_id,e.token_id,e.content_revision,e.received_at,length(CAST(e.payload AS BLOB)) AS bytes';
    const found=await db.prepare(`SELECT ${input?'t':'e'}.project_id,${fields},e.envelope_hash,COALESCE(e.raw_revision,0) AS raw_revision,
      c.provenance AS raw_provenance,${effectiveRawOwnerSql('c.owner_member_id','c.provenance','e.raw_revision')} AS raw_owner
      FROM json_each(?) j
      ${input?`JOIN tool_calls t ON t.project_id=json_extract(j.value,'$.project_id') AND t.tool_call_id=json_extract(j.value,'$.resource_id') JOIN events e ON e.project_id=t.project_id AND e.event_id=t.event_id`
        :`JOIN events e ON e.project_id=json_extract(j.value,'$.project_id') AND e.event_id=json_extract(j.value,'$.resource_id')`}
      LEFT JOIN raw_credentials c ON c.token_id=${input?'t':'e'}.token_id
      WHERE ${input?`t.input IS NOT NULL AND t.input_bundle_id IS NULL AND length(CAST(t.input AS BLOB))>${TOOL_INPUT_PREVIEW_BYTES}`:
        `e.payload_format='inline'${retention?'':" AND (e.producer_adapter='transcript-parse' OR e.channel='import') AND e.kind IN ('prompt','response','tool.use','tool.failure','plan.snapshot')"}`}`)
      .bind(JSON.stringify(selected)).all<ContentRow>();
    for(const row of found.results)rows.set(candidateKey({...row,resource_kind:kind}),row);
  }
  return rows;
}
const candidateKey=(id:Candidate)=>JSON.stringify([id.project_id,id.resource_kind,id.resource_id]);
async function candidate(db:RelationalStore,id:Candidate,retention=false):Promise<ContentRow|null> {
  return (await candidates(db,[id],retention)).get(candidateKey(id))??null;
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
    db.prepare(`DELETE FROM storage_cleanup_queue WHERE rowid IN
      (SELECT q.rowid FROM json_each(?) j CROSS JOIN storage_cleanup_queue q
        WHERE q.project_id=json_extract(j.value,'$.project_id')
          AND q.resource_kind=json_extract(j.value,'$.resource_kind')
          AND q.resource_id=json_extract(j.value,'$.resource_id'))`).bind(JSON.stringify(ids)),
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

const gainsSpace=(removed:number,metadata:number)=>removed>metadata*(1+STORAGE_CLEANUP_GAIN_MARGIN);
const removedBytes=(items:readonly BundleItem[])=>items.reduce((sum,item)=>sum+item.row.bytes-
  (item.kind==='event'?2:TOOL_INPUT_PREVIEW_BYTES),0);
const omissions=(db:RelationalStore,items:readonly BundleItem[],now:number)=>[
  db.prepare(`INSERT INTO storage_cleanup_omissions(project_id,resource_kind,resource_id,reason,observed_at)
    SELECT json_extract(value,'$.project_id'),json_extract(value,'$.kind'),json_extract(value,'$.resource_id'),
      'retained-inline:net-gain',? FROM json_each(?) WHERE true
    ON CONFLICT(project_id,resource_kind,resource_id) DO UPDATE SET reason=excluded.reason,observed_at=excluded.observed_at`)
    .bind(now,JSON.stringify(items.map(item=>({kind:item.kind,...item.row})))),
];
const paused=async(db:RelationalStore)=>{const state=await readState(db);
  if(!state)throw new Error('storage_cleanup_state_missing');return state.paused===1;};

/** Capture and parsing precede bounded session-page archive-and-clear work. */
export async function storageCleanup(env:Pick<ServerEnv,'db'|'blobs'>,now:number,
  options:{clock?:()=>number;statements?:number;blobCalls?:number;wallMs?:number}={}):Promise<{changed:number;more:boolean}>{
  const clock=options.clock??Date.now;const remaining=remainingContentBudget(env.db);
  const started=clock(),deadline=started+Math.min(options.wallMs??remaining.wallMs,remaining.wallMs);
  const limits={statements:Math.min(options.statements??remaining.statements,remaining.statements),
    blobCalls:Math.min(options.blobCalls??remaining.blobCalls,remaining.blobCalls)};
  const measured=measuredContentEnv(env,limits);let changed=0,longest=0,clearedBytes=0,metadataAdded=0;
  const room=(entries=0)=>clock()<deadline&&measured.usage.statements+STATEMENT_RESERVE+entries<=limits.statements
    &&measured.usage.blobCalls+BLOB_RESERVE<=limits.blobCalls;
  for(;;){
    if(clock()+longest>=deadline||!room())break;
    const start=clock();const state=await readState(measured.env.db);if(!state)throw new Error('storage_cleanup_state_missing');
    if(state.paused===1)return {changed,more:false};
    if(state.phase===3){await commitPage(measured.env.db,state,[],[],now,0,0,0,true);continue;}
    const consumed:Candidate[]=[];const items:BundleItem[]=[];let bytes=0,end=false,stop=false,budgetStop=false;
    let scan=state;
    while(!stop&&room(items.length)){
      if(await paused(measured.env.db))return {changed,more:false};
      const ids=await identities(measured.env.db,scan,consumed.at(-1));
      if(ids.length===0){end=true;break;}
      const found=await candidates(measured.env.db,ids);
      for(const id of ids){
        if(!room(items.length+1)){stop=true;budgetStop=true;break;}
        // Identity pages cannot carry an accumulator across a Project or session boundary.
        if(items.length&&(id.project_id!==items[0]!.row.project_id
          ||(id.session_id!==undefined&&id.session_id!==items[0]!.row.session_id))){stop=true;break;}
        const row=found.get(candidateKey(id));
        if(!row){consumed.push(id);continue;}
        if(items.length&&(!sameEvidence(items[0]!.row,row)||bytes+row.bytes>STORAGE_CLEANUP_PAGE_BYTES)){stop=true;break;}
        if(row.bytes>STORAGE_CLEANUP_PAGE_BYTES){
          if(items.length){stop=true;break;}
          if(!gainsSpace(removedBytes([{kind:id.resource_kind,row}]),projectedBundleMetadata([{kind:id.resource_kind,row}]))){
            consumed.push(id);await commitPage(measured.env.db,state,consumed,omissions(measured.env.db,[{kind:id.resource_kind,row}],now),now);
            consumed.length=0;stop=true;break;
          }
          const scans=await measured.env.db.prepare(`SELECT scanned_bytes FROM content_scan_checkpoints
            WHERE project_id=? AND source_kind=? AND resource_id=? AND content_revision=? AND envelope_hash=?`)
            .bind(row.project_id,id.resource_kind,row.resource_id,row.content_revision,row.envelope_hash).first<{scanned_bytes:number}>();
          if(scans?.scanned_bytes===row.bytes&&measured.usage.statements+STATEMENT_RESERVE+Math.ceil(row.bytes/STORAGE_CLEANUP_PAGE_BYTES)>limits.statements){stop=true;break;}
          const step=await prepareArchiveStep(measured.env,id.resource_kind,row,now);
          if(step.status==='pending'){if(consumed.length)await commitPage(measured.env.db,state,consumed,[],now);return {changed,more:true};}
          try {
            if(clock()>=deadline)return {changed,more:true};
            if(await paused(measured.env.db))return {changed,more:false};
            const cleared=row.bytes-(id.resource_kind==='event'?2:utf8(step.archive.preview).length);
            await commitPage(measured.env.db,state,[...consumed,id],bundleArchiveStatements(measured.env.db,step.archive.bundle),now,
              1,cleared,step.archive.bundle.metadataBytes);
            changed++;clearedBytes+=cleared;metadataAdded+=step.archive.bundle.metadataBytes;consumed.length=0;stop=true;break;
          } finally { await discardArchiveBundle(measured.env,step.archive.bundle,now); }
        }
        consumed.push(id);items.push({kind:id.resource_kind,row});bytes+=row.bytes;
        if(bytes>=STORAGE_CLEANUP_TARGET_BYTES||items.length>=ARCHIVE_BUNDLE_ENTRIES){stop=true;break;}
      }
      const last=consumed.at(-1);
      if(last)scan={...scan,cursor_project:last.project_id,cursor_id:last.resource_id,
        cursor_session:last.session_id??scan.cursor_session,cursor_created:last.created_at??scan.cursor_created,
        cursor_rowid:last.source_rowid??scan.cursor_rowid};
    }
    if((budgetStop||!room(items.length))&&changed>0)break;
    if(items.length){
      if(clock()>=deadline)return {changed,more:true};
      if(await paused(measured.env.db))return {changed,more:false};
      if(!gainsSpace(removedBytes(items),projectedBundleMetadata(items))){
        await commitPage(measured.env.db,state,consumed,omissions(measured.env.db,items,now),now);
      }else{
        const bundle=await prepareArchiveBundle(measured.env,items,now);
        try {
          if(clock()>=deadline)return {changed,more:true};
          if(await paused(measured.env.db))return {changed,more:false};
          const cleared=bundle.items.reduce((sum,item)=>sum+item.row.bytes-(item.kind==='event'?2:utf8(item.preview).length),0);
          if(!gainsSpace(cleared,bundle.metadataBytes))throw new Error('content_bundle_net_gain_invalid');
          await commitPage(measured.env.db,state,consumed,bundleArchiveStatements(measured.env.db,bundle),now,
            items.length,cleared,bundle.metadataBytes);
          changed+=items.length;clearedBytes+=cleared;metadataAdded+=bundle.metadataBytes;
        } finally { await discardArchiveBundle(measured.env,bundle,now); }
      }
    }else if(consumed.length)await commitPage(measured.env.db,state,consumed,[],now);
    else if(end){if(state.phase===4)break;await commitPage(measured.env.db,state,[],[],now,0,0,0,true);}
    else break;
    longest=Math.max(longest,clock()-start);
  }
  const more=await storageCleanupPending(measured.env.db);
  emit({kind:'storage_content_cleanup',rows:changed,cleared_bytes:clearedBytes,metadata_added_bytes:metadataAdded,
    ...measured.usage,elapsed_ms:clock()-started,more});
  return {changed,more};
}

/** Pause changes invalidate in-flight adoption while preserving every sweep cursor and bundle. */
export async function setStorageCleanupPaused(db:RelationalStore,value:boolean,now:number):Promise<CleanupState>{
  const result=await db.prepare(`UPDATE storage_cleanup_state SET paused=?,revision=revision+1,updated_at=? WHERE id=1`)
    .bind(value?1:0,now).run();
  if(result.meta.changes!==1)throw new Error('storage_cleanup_state_missing');
  return storageCleanupStatus(db);
}
export async function storageCleanupStatus(db:RelationalStore):Promise<CleanupState>{
  const state=await readState(db);if(!state)throw new Error('storage_cleanup_state_missing');return state;
}
export interface CleanupOmissionCursor {project_id:string;resource_kind:string;resource_id:string}
/** A primary-key page bounds examined omissions before live inline source checks. */
export async function storageCleanupRetainedInline(db:RelationalStore,after?:CleanupOmissionCursor):Promise<{
  counts:Array<{resource_kind:string;rows:number}>;next:CleanupOmissionCursor|null;examined:number;
}>{
  const page=(await db.prepare(`WITH page AS MATERIALIZED (
    SELECT project_id,resource_kind,resource_id,reason FROM storage_cleanup_omissions
    WHERE (project_id,resource_kind,resource_id)>(?,?,?) ORDER BY project_id,resource_kind,resource_id LIMIT ?)
    SELECT p.project_id,p.resource_kind,p.resource_id,
      p.reason='retained-inline:net-gain' AND CASE p.resource_kind
        WHEN 'event' THEN EXISTS(SELECT 1 FROM events e WHERE e.project_id=p.project_id AND e.event_id=p.resource_id AND e.payload_format='inline')
        WHEN 'tool-input' THEN EXISTS(SELECT 1 FROM tool_calls t WHERE t.project_id=p.project_id AND t.tool_call_id=p.resource_id
          AND t.input IS NOT NULL AND t.input_bundle_id IS NULL) ELSE 0 END AS retained
    FROM page p ORDER BY p.project_id,p.resource_kind,p.resource_id`)
    .bind(after?.project_id??'',after?.resource_kind??'',after?.resource_id??'',STORAGE_CLEANUP_ROWS+1)
    .all<CleanupOmissionCursor & {retained:number}>()).results;
  const examined=page.slice(0,STORAGE_CLEANUP_ROWS);const counts=new Map<string,number>();
  for(const row of examined)if(row.retained)counts.set(row.resource_kind,(counts.get(row.resource_kind)??0)+1);
  const last=examined.at(-1);
  return {counts:[...counts].map(([resource_kind,rows])=>({resource_kind,rows})),examined:examined.length,
    next:page.length>STORAGE_CLEANUP_ROWS&&last?{project_id:last.project_id,resource_kind:last.resource_kind,resource_id:last.resource_id}:null};
}
export async function storageCleanupPending(db:RelationalStore):Promise<boolean>{
  const state=await readState(db);if(!state)throw new Error('storage_cleanup_state_missing');
  if(state.paused===1)return false;
  if(state.complete===0)return await db.prepare(`SELECT 1 AS pending WHERE EXISTS(SELECT 1 FROM events LIMIT 1)
    OR EXISTS(SELECT 1 FROM tool_calls LIMIT 1) OR EXISTS(SELECT 1 FROM storage_cleanup_queue LIMIT 1)`).first()!==null;
  return await db.prepare('SELECT 1 AS pending FROM storage_cleanup_queue LIMIT 1').first()!==null;
}
