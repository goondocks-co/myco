import type { PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';
import { measuredContentEnv, remainingContentBudget } from './content-budget.js';
import { contentAssertion, prepareDerivedContent, prepareDerivedStream, verifiedContentSql, type DerivedContentSource } from './registered-content.js';
import { eventArchiveStatements, prepareArchiveStep } from './event-content.js';
import { cleanupCandidate } from './storage-cleanup.js';
import { transcriptRetentionFact } from '../ingest/retention.js';
import { observedSettingsGuard } from './settings.js';
import { emit } from '../telemetry.js';

const DAY_MS = 86_400_000;
const PAGE = 20;
interface State { phase:number;cursor_project:string;cursor_id:string;cursor_offset:number;due_received:number;due_kind:string;revision:number }
interface Due {project_id:string;source_kind:'event'|'transcript';source_id:string;session_id:string;size:number;
  received_at:number;transcript_id:string|null;base_offset:number|null;length:number|null;created_at:number|null;
  source_blob_key:string|null;source_generation:string|null;token_id:string;raw_revision:number;eligible_at:number}

const readState=(db:RelationalStore)=>db.prepare(`SELECT phase,cursor_project,cursor_id,cursor_offset,due_received,due_kind,revision
  FROM raw_archive_state WHERE id=1`).first<State>();
const parserPending=(t:string)=>`(COALESCE(json_extract(${t}.parser_context,'$.mycoParserUnfinished'),0)=1
  OR COALESCE(json_extract(${t}.parser_context,'$.mycoParserReplyUnfinished'),0)=1
  OR COALESCE(json_extract(${t}.parser_context,'$.mycoParserState.chunked'),0)=1
  OR COALESCE(json_extract(${t}.parser_context,'$.mycoLegacyResponseUntil'),
    json_extract(${t}.parser_context,'$.mycoParserRereadUntil'),
    json_extract(${t}.parser_context,'$.mycoParserState.legacyReplies.until'),0)>${t}.parsed_offset)`;
const stateGuard=(s:State)=>({sql:`EXISTS (SELECT 1 FROM raw_archive_state WHERE id=1 AND phase=?
  AND cursor_project=? AND cursor_id=? AND cursor_offset=? AND due_received=? AND due_kind=? AND revision=?)`,
  params:[s.phase,s.cursor_project,s.cursor_id,s.cursor_offset,s.due_received,s.due_kind,s.revision]});

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
      AND cursor_offset=? AND due_received=? AND due_kind=? AND revision=?`)
      .bind(next.phase??s.phase,next.cursor_project??s.cursor_project,next.cursor_id??s.cursor_id,
        next.cursor_offset??s.cursor_offset,next.due_received??s.due_received,next.due_kind??s.due_kind,...guard.params)]);
  if(results.at(-1)?.meta.changes!==1) throw new Error('raw_archive_cursor_changed');
}

/** Historical event identities are seeded in primary-key pages, with no payload read. */
async function seedEvents(db:RelationalStore,s:State):Promise<void> {
  const {results}=await db.prepare(`SELECT project_id,event_id FROM events WHERE (project_id,event_id)>(?,?)
    ORDER BY project_id,event_id LIMIT ?`).bind(s.cursor_project,s.cursor_id,PAGE)
    .all<{project_id:string;event_id:string}>();
  if(results.length===0) return commit(db,s,{phase:1,cursor_project:'',cursor_id:'',cursor_offset:-1},[]);
  const writes=results.map(id=>db.prepare(`INSERT INTO raw_archive_refs
    (project_id,source_kind,source_id,session_id,size,received_at,token_id,raw_revision,eligible_at)
    SELECT project_id,'event',event_id,session_id,COALESCE(payload_bytes,length(CAST(payload AS BLOB))),
      received_at,token_id,COALESCE(raw_revision,0),received_at FROM events
    WHERE project_id=? AND event_id=? AND payload_format='inline' ON CONFLICT DO NOTHING`)
    .bind(id.project_id,id.event_id));
  const last=results.at(-1)!;
  await commit(db,s,{cursor_project:last.project_id,cursor_id:last.event_id},writes);
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
    base_offset,length,created_at,source_blob_key,source_generation,token_id,raw_revision,eligible_at
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
    if(row.source_kind==='transcript') {
      const parser=await db.prepare(`SELECT parsed_offset,${parserPending('t')} AS pending,parse_error FROM transcripts t
        WHERE project_id=? AND transcript_id=?`).bind(row.project_id,row.transcript_id)
        .first<{parsed_offset:number;pending:number;parse_error:string|null}>();
      if(parser!==null&&row.base_offset!==null&&row.length!==null&&parser.parsed_offset>=row.base_offset+row.length
        && parser.pending===0&&parser.parse_error===null) {
        await archiveSegment(env,s,row,now,days,deadline);
        return 1;
      }
    } else {
      const candidate=await cleanupCandidate(db,{project_id:row.project_id,resource_id:row.source_id,resource_kind:'event'},true);
      if(candidate!==null) {
        const prepared=await prepareArchiveStep(env,'event',candidate,now);
        if(prepared.status==='pending') return 0;
        const archive=prepared.archive;
        if(Date.now()>=deadline) throw new Error('raw_archive_wall_budget_exhausted');
        const policy=await policyGuard(db,days);
        await commit(db,s,{cursor_project:row.project_id,cursor_id:row.source_id,due_received:row.eligible_at,
          due_kind:row.source_kind},[
          ...contentAssertion(db,`${policy.sql} AND EXISTS (SELECT 1 FROM raw_archive_refs r JOIN events e
            ON e.project_id=r.project_id AND e.event_id=r.source_id AND e.session_id=r.session_id
            WHERE r.project_id=? AND r.source_kind='event' AND r.source_id=? AND r.disposition='hot'
              AND r.received_at<=? AND r.raw_revision=e.raw_revision AND e.payload_format='inline')`,
            [...policy.params,row.project_id,row.source_id,cutoff]),
          ...eventArchiveStatements(db,candidate,archive),
          ...contentAssertion(db,`EXISTS (SELECT 1 FROM raw_archive_refs WHERE project_id=? AND source_kind='event'
            AND source_id=? AND disposition='archived' AND archive_key=? AND receipt_key=?)`,
            [row.project_id,row.source_id,archive.body.key,archive.receipt.key]),
        ]);
        return 1;
      }
      const already=await db.prepare(`SELECT 1 AS held FROM raw_archive_refs r JOIN event_content_refs c
        ON c.project_id=r.project_id AND c.event_id=r.source_id JOIN events e
        ON e.project_id=r.project_id AND e.event_id=r.source_id WHERE r.project_id=? AND r.source_kind='event'
          AND r.source_id=? AND e.payload_format='archived' AND c.source_envelope_hash=e.envelope_hash
          AND c.archive_key=r.archive_key AND c.receipt_key=r.receipt_key`).bind(row.project_id,row.source_id).first();
      if(already===null) throw new Error('raw_archive_event_source_missing');
    }
  }
  const last=results.at(-1)!;
  await commit(db,s,{cursor_project:last.project_id,cursor_id:last.source_id,due_received:last.eligible_at,
    due_kind:last.source_kind},[]);
  return 0;
}

/** One bounded seed or due page; every clear holds an exact registered body and receipt. */
export async function archiveRawSources(env:ServerEnv,now:number,days:number):Promise<number> {
  const started=Date.now();
  const remaining=remainingContentBudget(env.db);
  if(remaining.wallMs<=0) throw new Error('raw_archive_wall_budget_exhausted');
  const measured=measuredContentEnv(env,remaining);
  const state=await readState(measured.env.db);
  if(state===null) throw new Error('raw_archive_state_missing');
  if(state.phase===0) await seedEvents(measured.env.db,state);
  else if(state.phase===1) await seedSegments(measured.env.db,state);
  else if(state.phase===2) {
    const count=await archiveDue(measured.env,state,now,days,started+remaining.wallMs);
    emit({kind:'raw_archive_pass',rows:count,...measured.usage,elapsed_ms:Date.now()-started});
    return count;
  } else throw new Error('raw_archive_phase_invalid');
  emit({kind:'raw_archive_pass',rows:0,...measured.usage,elapsed_ms:Date.now()-started});
  return 0;
}
