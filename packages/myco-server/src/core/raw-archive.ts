import { clearArchivedTranscriptRanges } from '../db/documents/ranges.js';
import { learningHoldsSql } from '../db/learning/hold.js';
import type { PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';
import { measuredContentEnv, remainingContentBudget } from './content-budget.js';
import { contentAssertion, prepareDerivedContent, prepareDerivedStream, verifiedContentSql, type DerivedContentSource } from './registered-content.js';
import { cleanupCandidateRows, type CleanupCandidate } from '../db/storage/cleanup.js';
import { prepareArchiveStep, type ContentRow } from './event-content.js';
import { ARCHIVE_BUNDLE_ENTRIES, bundleArchiveStatements, discardArchiveBundle, prepareArchiveBundle } from './archive-bundle.js';
import { dueRawEvents, dueRawEventsBeside, dueSegments, publishedOffsetSql, rawEventArchiveCursor, type DueRawEvent, type DueSegment } from '../db/storage/raw-event-archive.js';
import { transcriptRetentionFact } from '../ingest/retention.js';
import { observedSettingsGuard } from './settings.js';
import { effectiveRawOwnerSql } from './raw-claims.js';
import { emit } from '../telemetry.js';

const DAY_MS = 86_400_000;
const PAGE = 20;
const RAW_EVENT_PAGE_BYTES = 1024 * 1024;
const RAW_EVENT_STATEMENT_RESERVE = 88;
const RAW_EVENT_BLOB_RESERVE = 8;
interface State { phase:number;cursor_project:string;cursor_id:string;cursor_offset:number;due_received:number;due_kind:string;revision:number }
interface RawEventPosition { cursor_received:number;cursor_rowid:number }
const readState=(db:RelationalStore)=>db.prepare(`SELECT phase,cursor_project,cursor_id,cursor_offset,due_received,due_kind,revision
  FROM raw_archive_state WHERE id=1`).first<State>();
const stateGuard=(s:State)=>({sql:`EXISTS (SELECT 1 FROM raw_archive_state WHERE id=1 AND phase=?
  AND cursor_project=? AND cursor_id=? AND cursor_offset=? AND due_received=? AND due_kind=? AND revision=?)`,
  params:[s.phase,s.cursor_project,s.cursor_id,s.cursor_offset,s.due_received,s.due_kind,s.revision]});
const rawEventStateGuard=(s:RawEventPosition&{revision:number})=>({sql:`EXISTS (SELECT 1 FROM raw_event_archive_state WHERE id=1
  AND cursor_received=? AND cursor_rowid=? AND revision=?)`,params:[s.cursor_received,s.cursor_rowid,s.revision]});

/** The stored leaves keep their observed versions through the archive transaction. */
async function policyGuard(db:RelationalStore,days:number):Promise<{sql:string;params:unknown[]}> {
  const guard=await observedSettingsGuard(db,['retention.raw_days','retention.transcripts']);
  const fact=await transcriptRetentionFact(guard.view);
  if(fact.state!=='days'||fact.days!==days) throw new Error('raw_archive_policy_changed');
  return {sql:guard.sql,params:guard.params};
}

/** Source changes and cursor advance commit together. */
async function commit(db:RelationalStore,s:State,next:Partial<State>,writes:PreparedStatement[]):Promise<void> {
  const guard=stateGuard(s);
  const results=await db.batch([...contentAssertion(db,guard.sql,guard.params),...writes,
    db.prepare(`UPDATE raw_archive_state SET phase=?,cursor_project=?,cursor_id=?,cursor_offset=?,due_received=?,due_kind=?,
      revision=revision+1,complete=0 WHERE id=1 AND phase=? AND cursor_project=? AND cursor_id=?
      AND cursor_offset=? AND due_received=? AND due_kind=? AND revision=? RETURNING revision`)
      .bind(next.phase??s.phase,next.cursor_project??s.cursor_project,next.cursor_id??s.cursor_id,
        next.cursor_offset??s.cursor_offset,next.due_received??s.due_received,next.due_kind??s.due_kind,...guard.params)]);
  if(results.at(-1)?.results.length!==1) throw new Error('raw_archive_cursor_changed');
}

/** Historical segment identities are seeded in numeric-offset pages. */
async function seedSegments(db:RelationalStore,s:State):Promise<void> {
  const {results}=await db.prepare(`SELECT project_id,transcript_id,base_offset FROM transcript_segments
    WHERE (project_id,transcript_id,base_offset)>(?,?,?) ORDER BY project_id,transcript_id,base_offset LIMIT ?`)
    .bind(s.cursor_project,s.cursor_id,s.cursor_offset,PAGE)
    .all<{project_id:string;transcript_id:string;base_offset:number}>();
  if(results.length===0) return commit(db,s,{phase:2,cursor_project:'',cursor_id:'',cursor_offset:-1,due_received:-1,due_kind:''},[]);
  const writes=results.flatMap(id=>[
    ...contentAssertion(db,`EXISTS (SELECT 1 FROM transcript_segments x JOIN transcripts t
      ON t.project_id=x.project_id AND t.transcript_id=x.transcript_id JOIN blobs b
      ON b.project_id=x.project_id AND b.key=x.blob_key WHERE x.project_id=? AND x.transcript_id=? AND x.base_offset=?)`,
      [id.project_id,id.transcript_id,id.base_offset]),
    db.prepare(`INSERT INTO raw_archive_refs
      (project_id,source_kind,source_id,session_id,size,received_at,transcript_id,base_offset,length,
       created_at,source_blob_key,token_id,source_generation,eligible_at)
      SELECT x.project_id,'transcript',x.transcript_id || ':' || x.base_offset,t.session_id,x.length,x.received_at,
        x.transcript_id,x.base_offset,x.length,x.created_at,x.blob_key,x.token_id,b.generation,x.received_at
      FROM transcript_segments x JOIN transcripts t ON t.project_id=x.project_id AND t.transcript_id=x.transcript_id
      JOIN blobs b ON b.project_id=x.project_id AND b.key=x.blob_key
      WHERE x.project_id=? AND x.transcript_id=? AND x.base_offset=? ON CONFLICT DO NOTHING`)
      .bind(id.project_id,id.transcript_id,id.base_offset)]);
  const last=results.at(-1)!;
  await commit(db,s,{cursor_project:last.project_id,cursor_id:last.transcript_id,cursor_offset:last.base_offset},writes);
}

/** A published segment's existing registered generation becomes its retained cold locator. */
async function archiveSegment(env:Pick<ServerEnv,'db'|'blobs'>,s:State,row:DueSegment,now:number,days:number,deadline:number):Promise<void> {
  const db=env.db;
  if(row.transcript_id===null||row.base_offset===null||row.length===null||row.created_at===null
    ||row.source_blob_key===null||row.size!==row.length) throw new Error('raw_archive_segment_metadata_missing');
  const sourceRow=await db.prepare(`SELECT x.event_id,x.blob_key,x.length,x.created_at,x.received_at,x.token_id,
    e.envelope_hash,${publishedOffsetSql('t')} AS published,b.generation FROM transcript_segments x
    JOIN transcripts t ON t.project_id=x.project_id AND t.transcript_id=x.transcript_id
    JOIN events e ON e.project_id=x.project_id AND e.event_id=x.event_id
    JOIN blobs b ON b.project_id=x.project_id AND b.key=x.blob_key
    WHERE x.project_id=? AND x.transcript_id=? AND x.base_offset=?`)
    .bind(row.project_id,row.transcript_id,row.base_offset).first<{
      event_id:string;blob_key:string;length:number;created_at:number;received_at:number;token_id:string;
      envelope_hash:string;published:number;generation:string|null}>();
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
  const guard=`${policy.sql} AND ${bodyProof.sql} AND ${receiptProof.sql}
    AND NOT EXISTS (SELECT 1 FROM recovery_holds WHERE released_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM (SELECT ? AS project_id, ? AS session_id) learning_source
      WHERE ${learningHoldsSql('learning_source.project_id', 'learning_source.session_id')})
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)
    AND EXISTS (SELECT 1 FROM raw_archive_refs r JOIN transcript_segments x
      ON x.project_id=r.project_id AND x.transcript_id=r.transcript_id AND x.base_offset=r.base_offset
      JOIN transcripts t ON t.project_id=x.project_id AND t.transcript_id=x.transcript_id
      JOIN blobs b ON b.project_id=x.project_id AND b.key=x.blob_key
      JOIN events e ON e.project_id=x.project_id AND e.event_id=x.event_id
      WHERE r.project_id=? AND r.source_kind='transcript' AND r.source_id=? AND r.disposition='hot'
        AND r.received_at<=? AND r.source_blob_key=x.blob_key AND r.source_generation IS b.generation
        AND r.length=x.length AND r.created_at=x.created_at AND r.token_id=x.token_id
        AND e.envelope_hash=? AND ${publishedOffsetSql('t')}>=x.base_offset+x.length)`;
  await commit(db,s,{cursor_project:row.project_id,cursor_id:row.source_id,due_received:row.eligible_at,
    due_kind:row.source_kind},[
    ...contentAssertion(db,guard,[...policy.params,...bodyProof.params,...receiptProof.params,
      row.project_id,row.session_id,row.project_id,row.session_id,row.project_id,row.source_id,now-days*DAY_MS,sourceRow.envelope_hash]),
    db.prepare(`UPDATE raw_archive_refs SET archive_key=?,receipt_key=?,digest=?,size=?,disposition='archived'
      WHERE project_id=? AND source_kind='transcript' AND source_id=? AND disposition='hot'`)
      .bind(body.key,receipt.key,body.digest,body.size,row.project_id,row.source_id),
    clearArchivedTranscriptRanges(db,row.project_id,row.transcript_id,row.base_offset),
    ...contentAssertion(db,`EXISTS (SELECT 1 FROM raw_archive_refs r JOIN blobs b
      ON b.project_id=r.project_id AND b.key=r.archive_key AND b.size=r.size
      WHERE r.project_id=? AND r.source_kind='transcript' AND r.source_id=? AND r.disposition='archived'
        AND r.archive_key=? AND r.receipt_key=?) AND NOT EXISTS
      (SELECT 1 FROM transcript_segments WHERE project_id=? AND transcript_id=? AND base_offset=?)`,
      [row.project_id,row.source_id,body.key,receipt.key,row.project_id,row.transcript_id,row.base_offset]),
  ]);
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
  const advance=async(last:Pick<DueRawEvent,'received_at'|'source_rowid'>|null,writes:PreparedStatement[],policy=false):Promise<void>=>{
    const guard=rawEventStateGuard(state);
    const held=policy?await policyGuard(db,days):null;
    const committed=await db.batch([
      ...contentAssertion(db,held===null?guard.sql:`${guard.sql} AND ${held.sql}`,
        held===null?guard.params:[...guard.params,...held.params]),
      ...writes,
      db.prepare(`UPDATE raw_event_archive_state SET cursor_received=?,cursor_rowid=?,revision=revision+1
        WHERE id=1 AND cursor_received=? AND cursor_rowid=? AND revision=? RETURNING revision`)
        .bind(last?.received_at??-1,last?.source_rowid??-1,...guard.params),
    ]);
    if(committed.at(-1)?.results.length!==1) throw new Error('raw_event_archive_cursor_changed');
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
    const sourceAge=`NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN events e
    ON e.project_id=json_extract(j.value,'$.project_id') AND e.event_id=json_extract(j.value,'$.event_id')
    LEFT JOIN raw_credentials c ON c.token_id=e.token_id
    WHERE e.event_id IS NULL OR e.session_id<>json_extract(j.value,'$.session_id')
      OR e.token_id<>json_extract(j.value,'$.token_id')
      OR COALESCE(e.raw_revision,0)<>json_extract(j.value,'$.raw_revision')
      OR e.received_at<>json_extract(j.value,'$.received_at') OR e.received_at>?
      OR e.payload_format<>'inline' OR c.provenance IS NOT json_extract(j.value,'$.raw_provenance')
      OR ${effectiveRawOwnerSql('c.owner_member_id','c.provenance','e.raw_revision')}
        IS NOT json_extract(j.value,'$.raw_owner'))`;
    const unheld = `NOT EXISTS (SELECT 1 FROM json_each(?) j
      WHERE ${learningHoldsSql("json_extract(j.value,'$.project_id')", "json_extract(j.value,'$.session_id')")})`;
    const writes=[...contentAssertion(db,unheld,[JSON.stringify(selected.map(({identity})=>identity))]),
      ...contentAssertion(db,sourceAge,[JSON.stringify(selected.map(({identity})=>identity)),cutoff]),
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
