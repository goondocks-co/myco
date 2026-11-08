import { cleanupCandidateRows, cleanupIdentities, cleanupOmissionStatement, cleanupScanCheckpoint, cleanupWorkPending, commitCleanupPage as commitPage,
  readCleanupOmissions, readCleanupState as readState, setCleanupPaused, type CleanupCandidate as Candidate, type CleanupOmissionCursor, type CleanupState } from '../db/storage/cleanup.js';
import type { RelationalStore, ServerEnv } from './adapters.js';
import { prepareArchiveStep, type ContentRow } from './event-content.js';
import { bundleArchiveStatements,discardArchiveBundle,prepareArchiveBundle,ARCHIVE_BUNDLE_BYTES,ARCHIVE_BUNDLE_ENTRIES,projectedBundleMetadata,type BundleItem } from './archive-bundle.js';
import { measuredContentEnv, remainingContentBudget } from './content-budget.js';
import { emit } from '../telemetry.js';



export const STORAGE_CLEANUP_ROWS = 100;
export const STORAGE_CLEANUP_TARGET_BYTES = 64 * 1024;
export const STORAGE_CLEANUP_GAIN_MARGIN = 0.2;
export const STORAGE_CLEANUP_PAGE_BYTES = ARCHIVE_BUNDLE_BYTES;
const ROW_RESERVE = 48;
const PENDING_STATUS_RESERVE = 2;
const STATEMENT_RESERVE = ROW_RESERVE + PENDING_STATUS_RESERVE;
const BLOB_RESERVE = 8;
export type { CleanupState,CleanupOmissionCursor };
/** Metadata is read first; exact UTF-8 bodies use a bounded page or checkpointed slices. */
async function candidates(db:RelationalStore,ids:Candidate[],retention=false):Promise<Map<string,ContentRow>> {
  const found=await cleanupCandidateRows(db,ids,retention);
  return new Map(found.map(row => [candidateKey({...row,resource_kind:'event'}),row]));
}
const candidateKey=(id:Candidate)=>JSON.stringify([id.project_id,id.resource_kind,id.resource_id]);
async function candidate(db:RelationalStore,id:Candidate,retention=false):Promise<ContentRow|null> {
  return (await candidates(db,[id],retention)).get(candidateKey(id))??null;
}
export {candidate as cleanupCandidate};

const sameEvidence=(a:ContentRow,b:ContentRow)=>a.project_id===b.project_id&&a.session_id===b.session_id
  &&a.token_id===b.token_id&&a.raw_owner===b.raw_owner&&a.raw_provenance===b.raw_provenance;

const gainsSpace=(removed:number,metadata:number)=>removed>metadata*(1+STORAGE_CLEANUP_GAIN_MARGIN);
const removedBytes=(items:readonly BundleItem[])=>items.reduce((sum,{kind,row})=>{
  if(kind!=='event'||!Number.isSafeInteger(row.retained_bytes)||row.retained_bytes!<0)throw new Error('content_retained_bytes_invalid');
  return sum+row.bytes-row.retained_bytes!;
},0);
const omissions=(db:RelationalStore,items:readonly BundleItem[],now:number)=>[
  cleanupOmissionStatement(db,now,JSON.stringify(items.map(item=>({kind:item.kind,...item.row})))),
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
      const ids=await cleanupIdentities(measured.env.db,scan,consumed.at(-1),STORAGE_CLEANUP_ROWS);
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
          const scanned=await cleanupScanCheckpoint(measured.env.db,row.project_id,id.resource_kind,row.resource_id,row.content_revision,row.envelope_hash);
          if(scanned===row.bytes&&measured.usage.statements+STATEMENT_RESERVE+Math.ceil(row.bytes/STORAGE_CLEANUP_PAGE_BYTES)>limits.statements){stop=true;break;}
          const step=await prepareArchiveStep(measured.env,id.resource_kind,row,now);
          if(step.status==='pending'){if(consumed.length)await commitPage(measured.env.db,state,consumed,[],now);return {changed,more:true};}
          try {
            if(clock()>=deadline)return {changed,more:true};
            if(await paused(measured.env.db))return {changed,more:false};
            const cleared=removedBytes([{kind:id.resource_kind,row}]);
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
          const cleared=removedBytes(bundle.items);
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
  if(!await setCleanupPaused(db,value,now))throw new Error('storage_cleanup_state_missing');
  return storageCleanupStatus(db);
}
export async function storageCleanupStatus(db:RelationalStore):Promise<CleanupState>{
  const state=await readState(db);if(!state)throw new Error('storage_cleanup_state_missing');return state;
}
/** A primary-key page bounds examined omissions before live inline source checks. */
export async function storageCleanupRetainedInline(db:RelationalStore,after?:CleanupOmissionCursor):Promise<{
  counts:Array<{resource_kind:string;rows:number}>;next:CleanupOmissionCursor|null;examined:number;
}>{
  const page=await readCleanupOmissions(db,after,STORAGE_CLEANUP_ROWS+1);
  const examined=page.slice(0,STORAGE_CLEANUP_ROWS);const counts=new Map<string,number>();
  for(const row of examined)if(row.retained)counts.set(row.resource_kind,(counts.get(row.resource_kind)??0)+1);
  const last=examined.at(-1);
  return {counts:[...counts].map(([resource_kind,rows])=>({resource_kind,rows})),examined:examined.length,
    next:page.length>STORAGE_CLEANUP_ROWS&&last?{project_id:last.project_id,resource_kind:last.resource_kind,resource_id:last.resource_id}:null};
}
export async function storageCleanupPending(db:RelationalStore):Promise<boolean>{
  const state=await readState(db);if(!state)throw new Error('storage_cleanup_state_missing');
  if(state.paused===1)return false;
  return cleanupWorkPending(db,state.complete!==0);
}
