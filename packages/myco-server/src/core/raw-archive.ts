import type { PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';
import { measuredContentEnv, remainingContentBudget } from './content-budget.js';
import { contentAssertion, prepareDerivedContent, prepareDerivedStream, verifiedContentSql, type DerivedContentSource } from './registered-content.js';
import { cleanupCandidate } from './storage-cleanup.js';
import { prepareArchiveStep, type ContentRow } from './event-content.js';
import { bundleArchiveStatements, discardArchiveBundle, prepareArchiveBundle } from './archive-bundle.js';
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
interface Due {project_id:string;source_kind:'transcript';source_id:string;session_id:string;size:number;
  received_at:number;transcript_id:string|null;base_offset:number|null;length:number|null;created_at:number|null;
  source_blob_key:string|null;source_generation:string|null;token_id:string;eligible_at:number}
interface RawEventState { cursor_project:string;cursor_session:string;cursor_created:number;cursor_rowid:number;revision:number }
interface RawEventIdentity { source_rowid:number;project_id:string;event_id:string;session_id:string;token_id:string;
  raw_revision:number;raw_owner:string|null;raw_provenance:string|null;
  created_at:number;received_at:number;payload_format:string }

const readState=(db:RelationalStore)=>db.prepare(`SELECT phase,cursor_project,cursor_id,cursor_offset,due_received,due_kind,revision
  FROM raw_archive_state WHERE id=1`).first<State>();
const readRawEventState=(db:RelationalStore)=>db.prepare(`SELECT cursor_project,cursor_session,cursor_created,cursor_rowid,revision
  FROM raw_event_archive_state WHERE id=1`).first<RawEventState>();
const parserPending=(t:string)=>`(COALESCE(json_extract(${t}.parser_context,'$.mycoParserUnfinished'),0)=1
  OR COALESCE(json_extract(${t}.parser_context,'$.mycoParserReplyUnfinished'),0)=1
  OR COALESCE(json_extract(${t}.parser_context,'$.mycoParserState.chunked'),0)=1
  OR COALESCE(json_extract(${t}.parser_context,'$.mycoLegacyResponseUntil'),
    json_extract(${t}.parser_context,'$.mycoParserRereadUntil'),
    json_extract(${t}.parser_context,'$.mycoParserState.legacyReplies.until'),0)>${t}.parsed_offset)`;
const stateGuard=(s:State)=>({sql:`EXISTS (SELECT 1 FROM raw_archive_state WHERE id=1 AND phase=?
  AND cursor_project=? AND cursor_id=? AND cursor_offset=? AND due_received=? AND due_kind=? AND revision=?)`,
  params:[s.phase,s.cursor_project,s.cursor_id,s.cursor_offset,s.due_received,s.due_kind,s.revision]});
const rawEventStateGuard=(s:RawEventState)=>({sql:`EXISTS (SELECT 1 FROM raw_event_archive_state WHERE id=1
  AND cursor_project=? AND cursor_session=? AND cursor_created=? AND cursor_rowid=? AND revision=?)`,
  params:[s.cursor_project,s.cursor_session,s.cursor_created,s.cursor_rowid,s.revision]});

/** The stored leaves keep their observed versions through the archive transaction. */
export async function policyGuard(db:RelationalStore,days:number):Promise<{sql:string;params:unknown[]}> {
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
      AND cursor_offset=? AND due_received=? AND due_kind=? AND revision=?`)
      .bind(next.phase??s.phase,next.cursor_project??s.cursor_project,next.cursor_id??s.cursor_id,
        next.cursor_offset??s.cursor_offset,next.due_received??s.due_received,next.due_kind??s.due_kind,...guard.params)]);
  if(results.at(-1)?.meta.changes!==1) throw new Error('raw_archive_cursor_changed');
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

/** A parsed segment's existing registered generation becomes its retained cold locator. */
async function archiveSegment(env:Pick<ServerEnv,'db'|'blobs'>,s:State,row:Due,now:number,days:number,deadline:number):Promise<void> {
  const db=env.db;
  if(row.transcript_id===null||row.base_offset===null||row.length===null||row.created_at===null
    ||row.source_blob_key===null||row.size!==row.length) throw new Error('raw_archive_segment_metadata_missing');
  const sourceRow=await db.prepare(`SELECT x.event_id,x.blob_key,x.length,x.created_at,x.received_at,x.token_id,
    e.envelope_hash,t.parsed_offset,${parserPending('t')} AS pending,t.parse_error,b.generation FROM transcript_segments x
    JOIN transcripts t ON t.project_id=x.project_id AND t.transcript_id=x.transcript_id
    JOIN events e ON e.project_id=x.project_id AND e.event_id=x.event_id
    JOIN blobs b ON b.project_id=x.project_id AND b.key=x.blob_key
    WHERE x.project_id=? AND x.transcript_id=? AND x.base_offset=?`)
    .bind(row.project_id,row.transcript_id,row.base_offset).first<{
      event_id:string;blob_key:string;length:number;created_at:number;received_at:number;token_id:string;
      envelope_hash:string;parsed_offset:number;pending:number;parse_error:string|null;generation:string|null}>();
  if(sourceRow===null) throw new Error('raw_archive_segment_source_missing');
  if(sourceRow.parsed_offset<row.base_offset+row.length||sourceRow.pending===1||sourceRow.parse_error!==null)
    throw new Error('raw_archive_segment_parser_pending');
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
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)
    AND EXISTS (SELECT 1 FROM raw_archive_refs r JOIN transcript_segments x
      ON x.project_id=r.project_id AND x.transcript_id=r.transcript_id AND x.base_offset=r.base_offset
      JOIN transcripts t ON t.project_id=x.project_id AND t.transcript_id=x.transcript_id
      JOIN blobs b ON b.project_id=x.project_id AND b.key=x.blob_key
      JOIN events e ON e.project_id=x.project_id AND e.event_id=x.event_id
      WHERE r.project_id=? AND r.source_kind='transcript' AND r.source_id=? AND r.disposition='hot'
        AND r.received_at<=? AND r.source_blob_key=x.blob_key AND r.source_generation IS b.generation
        AND r.length=x.length AND r.created_at=x.created_at AND r.token_id=x.token_id
        AND e.envelope_hash=? AND t.parsed_offset>=x.base_offset+x.length AND NOT ${parserPending('t')}
        AND t.parse_error IS NULL)`;
  await commit(db,s,{cursor_project:row.project_id,cursor_id:row.source_id,due_received:row.eligible_at,
    due_kind:row.source_kind},[
    ...contentAssertion(db,guard,[...policy.params,...bodyProof.params,...receiptProof.params,
      row.project_id,row.session_id,row.project_id,row.source_id,now-days*DAY_MS,sourceRow.envelope_hash]),
    db.prepare(`UPDATE raw_archive_refs SET archive_key=?,receipt_key=?,digest=?,size=?,disposition='archived'
      WHERE project_id=? AND source_kind='transcript' AND source_id=? AND disposition='hot'`)
      .bind(body.key,receipt.key,body.digest,body.size,row.project_id,row.source_id),
    db.prepare(`DELETE FROM transcript_segments WHERE project_id=? AND transcript_id=? AND base_offset=?
      AND blob_key=? AND length=? AND received_at=?`)
      .bind(row.project_id,row.transcript_id,row.base_offset,row.source_blob_key,row.length,row.received_at),
    ...contentAssertion(db,`EXISTS (SELECT 1 FROM raw_archive_refs r JOIN blobs b
      ON b.project_id=r.project_id AND b.key=r.archive_key AND b.size=r.size
      WHERE r.project_id=? AND r.source_kind='transcript' AND r.source_id=? AND r.disposition='archived'
        AND r.archive_key=? AND r.receipt_key=?) AND NOT EXISTS
      (SELECT 1 FROM transcript_segments WHERE project_id=? AND transcript_id=? AND base_offset=?)`,
      [row.project_id,row.source_id,body.key,receipt.key,row.project_id,row.transcript_id,row.base_offset]),
  ]);
}

/** The due index bounds identities examined even when most sources are held. */
async function archiveDue(env:Pick<ServerEnv,'db'|'blobs'>,s:State,now:number,days:number,deadline:number):Promise<number> {
  const db=env.db;
  const cutoff=now-days*DAY_MS;
  const {results}=await db.prepare(`SELECT project_id,source_kind,source_id,session_id,size,received_at,transcript_id,
    base_offset,length,created_at,source_blob_key,source_generation,token_id,eligible_at
    FROM raw_archive_refs INDEXED BY idx_raw_archive_refs_due WHERE disposition='hot' AND eligible_at<=?
      AND (eligible_at,project_id,source_kind,source_id)>(?,?,?,?)
    ORDER BY eligible_at,project_id,source_kind,source_id LIMIT ?`)
    .bind(cutoff,s.due_received,s.cursor_project,s.due_kind,s.cursor_id,PAGE).all<Due>();
  if(results.length===0) {
    if(s.due_received!==-1||s.cursor_project!=='') await commit(db,s,
      {cursor_project:'',cursor_id:'',due_received:-1,due_kind:''},[]);
    return 0;
  }
  for(const row of results) {
    const parser=await db.prepare(`SELECT parsed_offset,${parserPending('t')} AS pending,parse_error FROM transcripts t
      WHERE project_id=? AND transcript_id=?`).bind(row.project_id,row.transcript_id)
      .first<{parsed_offset:number;pending:number;parse_error:string|null}>();
    if(parser!==null&&row.base_offset!==null&&row.length!==null&&parser.parsed_offset>=row.base_offset+row.length
      && parser.pending===0&&parser.parse_error===null) {
      await archiveSegment(env,s,row,now,days,deadline);
      return 1;
    }
  }
  const last=results.at(-1)!;
  await commit(db,s,{cursor_project:last.project_id,cursor_id:last.source_id,due_received:last.eligible_at,
    due_kind:last.source_kind},[]);
  return 0;
}

/** A source-order page keeps session neighbors together without an event catalogue. */
async function archiveRawEventPage(env:Pick<ServerEnv,'db'|'blobs'>,now:number,days:number,deadline:number):Promise<number> {
  const db=env.db;
  const state=await readRawEventState(db);
  if(state===null) throw new Error('raw_event_archive_state_missing');
  const {results}=await db.prepare(`SELECT e.rowid AS source_rowid,e.project_id,e.event_id,e.session_id,e.token_id,
    COALESCE(e.raw_revision,0) AS raw_revision,c.provenance AS raw_provenance,
    ${effectiveRawOwnerSql('c.owner_member_id','c.provenance','e.raw_revision')} AS raw_owner,
    e.created_at,e.received_at,e.payload_format
    FROM events e INDEXED BY idx_events_session LEFT JOIN raw_credentials c ON c.token_id=e.token_id
    WHERE (e.project_id,e.session_id,e.created_at,e.rowid)>(?,?,?,?)
    ORDER BY e.project_id,e.session_id,e.created_at,e.rowid LIMIT ?`)
    .bind(state.cursor_project,state.cursor_session,state.cursor_created,state.cursor_rowid,PAGE)
    .all<RawEventIdentity>();
  const advance=async(last:RawEventIdentity|null,writes:PreparedStatement[],policy=false):Promise<void>=>{
    const guard=rawEventStateGuard(state);
    const held=policy?await policyGuard(db,days):null;
    const committed=await db.batch([
      ...contentAssertion(db,held===null?guard.sql:`${guard.sql} AND ${held.sql}`,
        held===null?guard.params:[...guard.params,...held.params]),
      ...writes,
      db.prepare(`UPDATE raw_event_archive_state SET cursor_project=?,cursor_session=?,cursor_created=?,
        cursor_rowid=?,revision=revision+1 WHERE id=1 AND cursor_project=? AND cursor_session=?
        AND cursor_created=? AND cursor_rowid=? AND revision=?`)
        .bind(last?.project_id??'',last?.session_id??'',last?.created_at??-1,last?.source_rowid??-1,...guard.params),
    ]);
    if(committed.at(-1)?.meta.changes!==1) throw new Error('raw_event_archive_cursor_changed');
  };
  if(results.length===0) {
    if(state.cursor_project!==''||state.cursor_session!=='') await advance(null,[]);
    return 0;
  }
  const cutoff=now-days*DAY_MS;
  const selected:Array<{kind:'event';row:ContentRow;identity:RawEventIdentity}>=[];
  let lastSkipped:RawEventIdentity|null=null;
  let bytes=0;
  for(const identity of results) {
    if(identity.received_at>cutoff||identity.payload_format!=='inline') {
      if(selected.length>0) break;
      lastSkipped=identity;
      continue;
    }
    if(selected.length>0) {
      const first=selected[0]!.identity;
      if(identity.project_id!==first.project_id||identity.session_id!==first.session_id
        ||identity.token_id!==first.token_id||identity.raw_owner!==first.raw_owner
        ||identity.raw_provenance!==first.raw_provenance) break;
    }
    const row=await cleanupCandidate(db,{project_id:identity.project_id,resource_id:identity.event_id,
      resource_kind:'event'},true);
    if(row===null) {
      if(selected.length>0) break;
      lastSkipped=identity;
      continue;
    }
    if(row.session_id!==identity.session_id||row.token_id!==identity.token_id
      ||(row.raw_revision??0)!==identity.raw_revision||row.received_at!==identity.received_at)
      throw new Error('raw_event_archive_source_changed');
    if(selected.length>0&&bytes+row.bytes>RAW_EVENT_PAGE_BYTES) break;
    selected.push({kind:'event',row,identity});
    bytes+=row.bytes;
    if(bytes>=RAW_EVENT_PAGE_BYTES) break;
  }
  if(selected.length===0) {
    await advance(results.at(-1)!,[]);
    return 0;
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
    const writes=[...contentAssertion(db,sourceAge,[JSON.stringify(selected.map(({identity})=>identity)),cutoff]),
      ...bundleArchiveStatements(db,bundle)];
    await advance(selected.at(-1)!.identity,writes,true);
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
    const rawState=await readRawEventState(measured.env.db);
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
