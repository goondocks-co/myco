import type { RelationalStore, ServerEnv } from './adapters.js';
import type { Bound } from '../db/index.js';
import { commitRawArchivePage, commitRawEventPage, rawEventsStillDue, readRawArchiveState, readSegmentSource, seedSegmentRef, segmentArchive,
  segmentsAfter, type RawArchiveState as State } from '../db/storage/raw-archive.js';
import { measuredContentEnv, remainingContentBudget } from './content-budget.js';
import { prepareDerivedContent, prepareDerivedStream, type DerivedContentSource } from './registered-content.js';
import { verifiedContentSql } from '../db/storage/content-source.js';
import { cleanupCandidateRows, type CleanupCandidate } from '../db/storage/cleanup.js';
import { prepareArchiveStep, type ContentRow } from './event-content.js';
import { ARCHIVE_BUNDLE_ENTRIES, bundleArchiveStatements, discardArchiveBundle, prepareArchiveBundle } from './archive-bundle.js';
import { dueRawEvents, dueRawEventsBeside, dueSegments, rawEventArchiveCursor, type DueRawEvent, type DueSegment } from '../db/storage/raw-event-archive.js';
import { transcriptRetentionFact } from '../ingest/retention.js';
import { observedSettingsGuard } from './settings.js';
import { emit } from '../telemetry.js';

const DAY_MS = 86_400_000;
const PAGE = 20;
const RAW_EVENT_PAGE_BYTES = 1024 * 1024;
const RAW_EVENT_STATEMENT_RESERVE = 88;
const RAW_EVENT_BLOB_RESERVE = 8;
const readState=readRawArchiveState;

/** The stored leaves keep their observed versions through the archive transaction. */
async function policyGuard(db:RelationalStore,days:number):Promise<{sql:string;params:unknown[]}> {
  const guard=await observedSettingsGuard(db,['retention.raw_days','retention.transcripts']);
  const fact=await transcriptRetentionFact(guard.view);
  if(fact.state!=='days'||fact.days!==days) throw new Error('raw_archive_policy_changed');
  return {sql:guard.sql,params:guard.params};
}

/** Source changes and cursor advance commit together. */
async function commit(db:RelationalStore,s:State,next:Partial<State>,writes:Bound<never,'write'>[]):Promise<void> {
  if(!await commitRawArchivePage(db,s,next,writes)) throw new Error('raw_archive_cursor_changed');
}

/** Historical segment identities are seeded in numeric-offset pages. */
async function seedSegments(db:RelationalStore,s:State):Promise<void> {
  const results=await segmentsAfter(db,s,PAGE);
  if(results.length===0) return commit(db,s,{phase:2,cursor_project:'',cursor_id:'',cursor_offset:-1,due_received:-1,due_kind:''},[]);
  const writes=results.flatMap(seedSegmentRef);
  const last=results.at(-1)!;
  await commit(db,s,{cursor_project:last.project_id,cursor_id:last.transcript_id,cursor_offset:last.base_offset},writes);
}

/** A published segment's existing registered generation becomes its retained cold locator. */
async function archiveSegment(env:Pick<ServerEnv,'db'|'blobs'>,s:State,row:DueSegment,now:number,days:number,deadline:number):Promise<void> {
  const db=env.db;
  if(row.transcript_id===null||row.base_offset===null||row.length===null||row.created_at===null
    ||row.source_blob_key===null||row.size!==row.length) throw new Error('raw_archive_segment_metadata_missing');
  const sourceRow=await readSegmentSource(db,row.project_id,row.transcript_id,row.base_offset);
  if(sourceRow===null) throw new Error('raw_archive_segment_source_missing');
  if(sourceRow.published<row.base_offset+row.length) throw new Error('raw_archive_segment_unpublished');
  if(sourceRow.blob_key!==row.source_blob_key||sourceRow.generation!==row.source_generation
    ||sourceRow.length!==row.length||sourceRow.created_at!==row.created_at||sourceRow.received_at!==row.received_at
    ||sourceRow.token_id!==row.token_id) throw new Error('raw_archive_segment_source_changed');
  const source:DerivedContentSource={projectId:row.project_id,sessionId:row.session_id,eventId:sourceRow.event_id,
    tokenId:row.token_id,envelopeHash:sourceRow.envelope_hash,sourceKind:'transcript',resourceId:row.source_id};
  const body=await prepareDerivedStream(env,source,{size:row.length,digest:row.source_blob_key,
    stream:()=>{throw new Error('raw_archive_segment_registration_missing');}},now);
  const receipt=await prepareDerivedContent(env,{...source,sourceKind:'receipt',resourceId:`transcript:${row.source_id}`},
    JSON.stringify({version:1,source,body,baseOffset:row.base_offset,length:row.length,
      createdAt:row.created_at,receivedAt:row.received_at}),now);
  if(Date.now()>=deadline) throw new Error('raw_archive_wall_budget_exhausted');
  const policy=await policyGuard(db,days);
  const bodyProof=verifiedContentSql(source,body);
  const receiptProof=verifiedContentSql({...source,sourceKind:'receipt',resourceId:`transcript:${row.source_id}`},receipt);
  await commit(db,s,{cursor_project:row.project_id,cursor_id:row.source_id,due_received:row.eligible_at,
    due_kind:row.source_kind},segmentArchive({projectId:row.project_id,sessionId:row.session_id,sourceId:row.source_id,
    transcriptId:row.transcript_id,baseOffset:row.base_offset,cutoff:now-days*DAY_MS,envelopeHash:sourceRow.envelope_hash,
    body,receiptKey:receipt.key,policy,bodyProof,receiptProof}));
}

/** The due index bounds identities examined even when most sources are held; one statement reads each row's holds. */
async function archiveDue(env:Pick<ServerEnv,'db'|'blobs'>,s:State,now:number,days:number,deadline:number):Promise<number> {
  const db=env.db;
  const cutoff=now-days*DAY_MS;
  const page=await dueSegments(db,cutoff,{received:s.due_received,project:s.cursor_project,kind:s.due_kind,id:s.cursor_id},PAGE);
  if(page.length===0) {
    if(s.due_received!==-1||s.cursor_project!=='') await commit(db,s,
      {cursor_project:'',cursor_id:'',due_received:-1,due_kind:''},[]);
    return 0;
  }
  for(const row of page) {
    if(row.held===1||row.base_offset===null||row.length===null||row.published<row.base_offset+row.length) continue;
    await archiveSegment(env,s,row,now,days,deadline);
    return 1;
  }
  const last=page.at(-1)!;
  await commit(db,s,{cursor_project:last.project_id,cursor_id:last.source_id,due_received:last.eligible_at,
    due_kind:last.source_kind},[]);
  return 0;
}

/** Whether two rows may share one archive bundle: one session and one immutable uploader evidence class. */
const sameEvidence=(a:DueRawEvent,b:DueRawEvent)=>a.project_id===b.project_id&&a.session_id===b.session_id&&a.token_id===b.token_id
  &&a.raw_owner===b.raw_owner&&a.raw_provenance===b.raw_provenance;

/** One page of hot events past the held cursor, oldest first: a due head and its session neighbours become one bundle, and only rows that remain due and unheld stay ahead of the cursor. */
async function archiveRawEventPage(env:Pick<ServerEnv,'db'|'blobs'>,now:number,days:number,deadline:number):Promise<number> {
  const db=env.db;
  const state=await rawEventArchiveCursor(db);
  if(state===null) throw new Error('raw_event_archive_state_missing');
  const cutoff=now-days*DAY_MS;
  const heads=await dueRawEvents(db,state,cutoff,PAGE);
  const advance=async(last:Pick<DueRawEvent,'received_at'|'source_rowid'>|null,writes:Bound<never,'write'>[],policy=false):Promise<void>=>{
    const held=policy?await policyGuard(db,days):null;
    if(!await commitRawEventPage(db,state,last,writes,held)) throw new Error('raw_event_archive_cursor_changed');
  };
  if(heads.length===0) {
    if(state.cursor_received!==-1||state.cursor_rowid!==-1) await advance(null,[]);
    return 0;
  }
  const firstEligible=heads.findIndex(head=>head.held===0);
  if(firstEligible===-1) {
    await advance(heads.at(-1)!,[]);
    return 0;
  }
  const lastSkipped=firstEligible>0?heads[firstEligible-1]!:null;
  const head=heads[firstEligible]!;
  const neighbours=await dueRawEventsBeside(db,head,ARCHIVE_BUNDLE_ENTRIES,cutoff);
  const ids:CleanupCandidate[]=neighbours.map(row=>({project_id:row.project_id,resource_id:row.event_id,resource_kind:'event'}));
  const candidates=new Map((await cleanupCandidateRows(db,ids,true)).map(row=>[row.resource_id,row]));
  if(!candidates.has(head.event_id)) {
    await advance(head,[]);
    return 0;
  }
  const selected:Array<{kind:'event';row:ContentRow;identity:DueRawEvent}>=[];
  let bytes=0;
  for(const identity of neighbours) {
    if(!sameEvidence(identity,head)) break;
    const row=candidates.get(identity.event_id);
    if(row===undefined) break;
    if(row.session_id!==identity.session_id||row.token_id!==identity.token_id
      ||(row.raw_revision??0)!==identity.raw_revision||row.received_at!==identity.received_at)
      throw new Error('raw_event_archive_source_changed');
    if(selected.length>0&&bytes+row.bytes>RAW_EVENT_PAGE_BYTES) break;
    selected.push({kind:'event',row,identity});
    bytes+=row.bytes;
    if(bytes>=RAW_EVENT_PAGE_BYTES) break;
  }
  const first=selected[0]!;
  const step=first.row.bytes>RAW_EVENT_PAGE_BYTES
    ?await prepareArchiveStep(env,'event',first.row,now)
    :null;
  if(step?.status==='pending') {
    if(lastSkipped!==null) await advance(lastSkipped,[]);
    return 0;
  }
  const bundle=step===null
    ?await prepareArchiveBundle(env,selected.map(({kind,row})=>({kind,row})),now)
    :step.archive.bundle;
  try {
    if(Date.now()>=deadline) throw new Error('raw_archive_wall_budget_exhausted');
    const writes=[...rawEventsStillDue(JSON.stringify(selected.map(({identity})=>identity)),cutoff),
      ...bundleArchiveStatements(db,bundle)];
    await advance(lastSkipped??{received_at:state.cursor_received,source_rowid:state.cursor_rowid},writes,true);
    return selected.length;
  } finally { await discardArchiveBundle(env,bundle,now); }
}

/** One bounded seed or due page; every clear holds an exact registered body and receipt. */
export async function archiveRawSources(env:ServerEnv,now:number,days:number):Promise<number> {
  const started=Date.now();
  const remaining=remainingContentBudget(env.db);
  if(remaining.wallMs<=0) throw new Error('raw_archive_wall_budget_exhausted');
  const measured=measuredContentEnv(env,remaining);
  const state=await readState(measured.env.db);
  if(state===null) throw new Error('raw_archive_state_missing');
  if(state.phase===0) await commit(measured.env.db,state,{phase:1,cursor_project:'',cursor_id:'',cursor_offset:-1},[]);
  else if(state.phase===1) await seedSegments(measured.env.db,state);
  else if(state.phase===2) {
    let count=0;
    const budget=()=>remainingContentBudget(measured.env.db);
    const admitted=()=>{const left=budget();return left.statements>=RAW_EVENT_STATEMENT_RESERVE
      &&left.blobCalls>=RAW_EVENT_BLOB_RESERVE&&left.wallMs>0&&Date.now()<started+remaining.wallMs;};
    const rawState=await rawEventArchiveCursor(measured.env.db);
    if(rawState===null) throw new Error('raw_event_archive_state_missing');
    const rawFirst=(state.revision+rawState.revision)%2===0;
    if(rawFirst&&admitted()) {
      count+=await archiveRawEventPage(measured.env,now,days,started+remaining.wallMs);
    }
    if(admitted())
      count+=await archiveDue(measured.env,state,now,days,started+remaining.wallMs);
    if(!rawFirst&&admitted()) {
      count+=await archiveRawEventPage(measured.env,now,days,started+remaining.wallMs);
    }
    emit({kind:'raw_archive_pass',rows:count,...measured.usage,elapsed_ms:Date.now()-started});
    return count;
  } else throw new Error('raw_archive_phase_invalid');
  emit({kind:'raw_archive_pass',rows:0,...measured.usage,elapsed_ms:Date.now()-started});
  return 0;
}
