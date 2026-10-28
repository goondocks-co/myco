import {canonicalPromptId} from '@goondocks/myco-shared/prompt-identity';
import {AsyncLocalStorage} from 'node:async_hooks';
import {spyOn,it as registerTest} from 'bun:test';
const writerBackend=new AsyncLocalStorage<boolean>();
export const writerReadBackend=()=>writerBackend.getStore()??process.env.MYCO_VIEW_WRITER_BACKEND==='1';
export function writerReadTest(name:string,run:()=>void|Promise<void>,timeout?:number,backend=true){return registerTest(name,()=>writerBackend.run(backend,run),timeout)}
import {captureViewTranscript} from './view-stores.js';
import {legacyBodyBlobs} from '../../helpers/view-read-legacy-fixtures.js';
import {fixtureFlipEnvelope} from '../../helpers/view-flip-envelope.js';
import {requestViewRebuild,tryPublishView} from '@myco-server-worker/ingest/view-lifecycle.js';
import {claimViewBuild,SERIAL_VIEW_BUDGET} from '@myco-server-worker/ingest/view-build-queue.js';
import {parseViewOnce} from '@myco-server-worker/ingest/view-parse.js';
import {PARSER_VERSION} from '@myco-server-worker/ingest/parse.js';
import {verifyContentObject} from '@myco-server-worker/core/registered-content.js';
import {blobObjectKey} from '@myco-server-worker/core/blob-objects.js';
import {viewContentHash} from '@myco-server-worker/core/material-content.js';
import {uuidv5} from '@myco-server-worker/hash.js';
import {withViewWriterDriver} from '../../helpers/statement-recorder.js';
import {withIndependentReadPreparation} from '../../helpers/statement-recorder.js';
import type { PreparedStatement,RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { VIEW_MATERIALS, VIEW_SESSION_TABLES } from '@myco-server-worker/db/view-tables.js';
import { uuid } from './fixtures.js';

export const INSTANCE_STATES = ['building', 'live', 'frozen', 'retired', 'failed', 'abandoned'] as const;

/** A controlled stamp corruption exercises the executing-version assertion. */
export async function setViewParserVersion(db:RelationalStore,project:string,instance:string,version:number):Promise<void>{
 await db.prepare(`UPDATE view_instances SET parser_version=? WHERE project_id=? AND instance_id=?`).bind(version,project,instance).run();
}

/** A completed legacy classification page admits the publication-tail fixture. */
export async function completeViewConversion(db:RelationalStore,project:string,session:string,promptId:string):Promise<void>{
 await db.batch([
  db.prepare(`INSERT OR IGNORE INTO fact_classes(project_id,table_name,record_id,session_id,class,classified_at) VALUES(?,'prompt_batches',?,?,'legacy',1)`).bind(project,promptId,session),
  db.prepare(`UPDATE session_views SET legacy='converting' WHERE project_id=? AND session_id=?`).bind(project,session),
  db.prepare(`UPDATE view_build_work SET classification_complete=1,coverage_complete=1,receipts_complete=1 WHERE project_id=? AND session_id=?`).bind(project,session),
 ]);
}

/** A restored frozen frontier and its live tail retain independent parser generations. */
export async function seedTailFrontier(db:RelationalStore,project:string,session:string,parent:string,tail:string,transcript:string,offset:number,version:number):Promise<void>{
 const context=JSON.stringify({mycoParserViewCheckpoint:1,mycoParserState:{pending:{old:{toolCallId:'old',toolName:'forbidden inherited call',input:{held:true},createdAt:1,offset:0}}}});
 await db.batch([
  db.prepare(`DELETE FROM transcript_segments WHERE project_id=? AND transcript_id=? AND base_offset<?`).bind(project,transcript,offset),
  db.prepare(`UPDATE view_instances SET state='frozen',base='frozen',parser_version=? WHERE project_id=? AND instance_id=?`).bind(version-1,project,parent),
  db.prepare(`INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,parent_instance,state,created_at) VALUES(?,?,?,?,'tail',?,'live',1)`)
   .bind(project,tail,session,version,parent),
  ...[parent,tail].map(instance=>db.prepare(`INSERT INTO view_checkpoints(project_id,instance_id,session_id,transcript_id,ordinal,start_offset,parsed_offset,parser_context,open_prompt_id)
    VALUES(?,?,?,?,0,?,?,?,'forbidden-inherited-prompt')`).bind(project,instance,session,transcript,instance===parent?0:offset,offset,context)),
  db.prepare(`UPDATE session_views SET live_instance=? WHERE project_id=? AND session_id=?`).bind(tail,project,session),
  db.prepare(`UPDATE view_visible SET role='parent',precedence=1 WHERE project_id=? AND instance_id=?`).bind(project,parent),
  db.prepare(`INSERT INTO view_visible(project_id,instance_id,session_id,role,precedence) VALUES(?,?,?,'live',0)`).bind(project,tail,session),
 ]);
}

/** The observer runs between publication preparation and the one atomic batch. */
export function beforeViewFlip(db:RelationalStore,before:()=>Promise<void>):RelationalStore{
 return beforeViewWriteBatch(db,sql=>sql.includes("SET state='retired'"),before,true);
}

/** A controlled concurrent writer runs immediately before each selected atomic batch. */
export function beforeViewWriteBatch(db:RelationalStore,selectedSql:(sql:string)=>boolean,before:()=>Promise<void>,once=false):RelationalStore{
 const statements=new WeakMap<PreparedStatement,{raw:PreparedStatement;sql:string}>();let armed=true;
 const wrap=(raw:PreparedStatement,sql:string):PreparedStatement=>{
  const statement:PreparedStatement={bind:(...values)=>wrap(raw.bind(...values),sql),first:<T>()=>raw.first<T>(),all:<T>()=>raw.all<T>(),run:()=>raw.run()};
  statements.set(statement,{raw,sql});return statement;
 };
 return {prepare:sql=>wrap(db.prepare(sql),sql),batch:async selected=>{
  const held=selected.map(statement=>{const value=statements.get(statement);if(!value)throw new Error('fixture statement belongs to another store');return value;});
  if(armed&&held.some(value=>selectedSql(value.sql))){if(once)armed=false;await withIndependentReadPreparation(before);}
  return db.batch(held.map(value=>value.raw));
 }};
}

/** Capture arriving before checkpoint selection belongs to the pass's selected size. */
export function beforeViewCheckpointRead(db:RelationalStore,before:()=>Promise<void>):RelationalStore{
 const held=new WeakMap<PreparedStatement,PreparedStatement>(),reads=new WeakSet<PreparedStatement>();
 const wrap=(raw:PreparedStatement,selected:boolean):PreparedStatement=>{
  const statement:PreparedStatement={
   bind:(...values)=>wrap(raw.bind(...values),selected),
   first:async<T>()=>{if(selected)await withIndependentReadPreparation(before);return raw.first<T>();},
   all:<T>()=>raw.all<T>(),run:()=>raw.run(),
  };
  held.set(statement,raw);if(selected)reads.add(statement);return statement;
 };
 return {prepare:sql=>wrap(db.prepare(sql),sql.includes('c.transcript_id checkpoint_id')),
  batch:async statements=>{
   if(statements.some(statement=>reads.has(statement)))await withIndependentReadPreparation(before);
   return db.batch(statements.map(statement=>{const raw=held.get(statement);if(!raw)throw new Error('fixture statement belongs to another store');return raw;}));
  }};
}
export interface SyntheticInstance {
  projectId: string;
  sessionId: string;
  instanceId: string;
  state: typeof INSTANCE_STATES[number];
  parent?: string;
  toolCallId?: string;
}

/** Synthetic parser storage with one row in each instance-owned table. */
export async function seedViewInstance(db: RelationalStore, value: SyntheticInstance): Promise<string[]> {
  const { projectId: project, sessionId: session, instanceId: id, state, parent } = value;
  const keys = await Promise.all(['prompt', 'response', 'input', 'output', 'plan', 'proof'].map(kind => sha256Hex(`${project}:${id}:${kind}`)));
  await db.batch([
    ...keys.map((key, index) => db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
      VALUES(?,?,1,'text/plain','synthetic',1,?)`).bind(project, key, uuid(100 + index))),
    db.prepare(`INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,parent_instance,state,created_at)
      VALUES(?,?,?,1,?,?,?,1)`).bind(project, id, session, parent === undefined ? (state === 'frozen' ? 'frozen' : 'full') : 'tail', parent ?? null, state),
    db.prepare(`INSERT INTO view_checkpoints(project_id,instance_id,session_id,transcript_id,ordinal,start_offset,parsed_offset)
      VALUES(?,?,?,'transcript',0,0,1)`).bind(project, id, session),
    db.prepare(`INSERT INTO view_checkpoint_chunks(project_id,instance_id,session_id,transcript_id,cursor_offset,chunk_index,chunk_count,payload)
      VALUES(?,?,?,'transcript',1,0,1,'{}')`).bind(project, id, session),
    db.prepare(`INSERT INTO view_key_owners(project_id,instance_id,session_id,source_key,source_thread,source_record,source_transcript_id,source_offset,created_at)
      VALUES(?,?,?,'key','thread','record','transcript',0,1)`).bind(project, id, session),
    db.prepare(`INSERT INTO view_prompts(project_id,instance_id,session_id,prompt_id,origin,text,blob_key,content_hash,created_at,updated_at,received_at)
      VALUES(?,?,?,'prompt','user','viewcanary',?,'hash',1,1,1)`).bind(project, id, session, keys[0]),
    db.prepare(`INSERT INTO view_responses(project_id,instance_id,session_id,response_id,prompt_id,text,blob_key,content_hash,created_at,received_at)
      VALUES(?,?,?,'response','prompt','viewcanary',?,'hash',1,1)`).bind(project, id, session, keys[1]),
    db.prepare(`INSERT INTO view_tool_calls(project_id,instance_id,session_id,tool_call_id,prompt_id,tool_name,input_blob_key,output_blob_key,success,created_at,received_at)
      VALUES(?,?,?,?,'prompt','Read',?,?,1,1,1)`).bind(project, id, session, value.toolCallId ?? 'tool', keys[2], keys[3]),
    db.prepare(`INSERT INTO view_plans(project_id,instance_id,session_id,plan_key,prompt_id,title,content,blob_key,content_hash,status,created_at,updated_at,received_at)
      VALUES(?,?,?,?,'prompt','viewcanary','viewcanary',?,'hash','active',1,1,1)`).bind(project, id, session, uuid(50), keys[4]),
    db.prepare(`INSERT INTO view_content_proofs(project_id,instance_id,session_id,kind,record_id,blob_key,digest,size,verified_at)
      VALUES(?,?,?,'prompt','proof-only',?,?,1,1)`).bind(project, id, session, keys[5], keys[5]),
    db.prepare(`INSERT INTO view_findings(project_id,instance_id,session_id,kind,record_id,n)
      VALUES(?,?,?,'key_reuse','prompt',0)`).bind(project, id, session),
  ]);
  return keys;
}

export async function updateViewSearchText(db: RelationalStore, project: string, instance: string, text: string): Promise<void> {
  await db.batch(VIEW_MATERIALS.filter(material => material.fts.length > 0).map(material =>
    db.prepare(`UPDATE ${material.table} SET ${material.fts.map(column => `${column}=?`).join(',')}
      WHERE project_id=? AND instance_id=?`).bind(...material.fts.map(() => text), project, instance)));
}

/** Distinct layer values let readers prove precedence before their filters. */
export async function setViewLayerValues(db: RelationalStore, project: string, instance: string, value: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE view_prompts SET text=?,origin=? WHERE project_id=? AND instance_id=?').bind(value, value, project, instance),
    db.prepare('UPDATE view_responses SET text=? WHERE project_id=? AND instance_id=?').bind(value, project, instance),
    db.prepare('UPDATE view_tool_calls SET tool_name=?,input=? WHERE project_id=? AND instance_id=?').bind(value, value, project, instance),
    db.prepare('UPDATE view_plans SET title=?,content=?,status=? WHERE project_id=? AND instance_id=?').bind(value, value, value, project, instance),
  ]);
}

export async function keepSurvivingFacts(db: RelationalStore, project: string, session: string): Promise<void> {
  await db.prepare('DELETE FROM fact_classes WHERE project_id=? AND session_id=?').bind(project, session).run();
}

export async function removeViewMaterialRows(db: RelationalStore, project: string, instance: string): Promise<void> {
  await db.batch(VIEW_MATERIALS.map(material => db.prepare(`DELETE FROM ${material.table} WHERE project_id=? AND instance_id=?`).bind(project, instance)));
}

const BODY_FIELDS = {
  prompt: { table: 'view_prompts', id: 'prompt_id', text: 'text', blob: 'blob_key' },
  response: { table: 'view_responses', id: 'response_id', text: 'text', blob: 'blob_key' },
  plan: { table: 'view_plans', id: 'plan_key', text: 'content', blob: 'blob_key' },
  'tool-input': { table: 'view_tool_calls', id: 'tool_call_id', text: 'input', blob: 'input_blob_key' },
  'tool-output': { table: 'view_tool_calls', id: 'tool_call_id', text: 'output_preview', blob: 'output_blob_key' },
} as const;

/** Exact body proofs belong to the named synthetic instance and canonical record. */
export async function setViewFieldBody(db: RelationalStore, value: {
  projectId: string; instanceId: string; sessionId: string; kind: keyof typeof BODY_FIELDS; recordId: string;
  key: string; size: number; proved: boolean;
}): Promise<void> {
  const field = BODY_FIELDS[value.kind];
  await db.batch([
    db.prepare(`UPDATE ${field.table} SET ${field.text}=NULL,${field.blob}=? WHERE project_id=? AND instance_id=? AND ${field.id}=?`)
      .bind(value.key, value.projectId, value.instanceId, value.recordId),
    db.prepare('DELETE FROM view_content_proofs WHERE project_id=? AND instance_id=? AND kind=? AND record_id=? AND blob_key=?')
      .bind(value.projectId, value.instanceId, value.kind, value.recordId, value.key),
    ...(value.proved ? [db.prepare(`INSERT INTO view_content_proofs(project_id,instance_id,session_id,kind,record_id,blob_key,digest,size,verified_at)
      VALUES(?,?,?,?,?,?,?,?,1)`).bind(value.projectId, value.instanceId, value.sessionId, value.kind, value.recordId, value.key, value.key, value.size)] : []),
  ]);
}

export async function setViewToolBundle(db: RelationalStore, project: string, instance: string, bundleId: number | null): Promise<void> {
  await db.prepare(`UPDATE view_tool_calls SET input_bundle_id=?,input_bundle_entry=?
    WHERE project_id=? AND instance_id=?`).bind(bundleId, bundleId === null ? null : 0, project, instance).run();
}

/** Synthetic publication metadata; no production publisher is invoked. */
export async function seedViewState(db: RelationalStore, project: string, session: string, live: string, parent?: string): Promise<void> {
  await db.batch([
    db.prepare(`INSERT INTO session_views(project_id,session_id,live_instance,fence,legacy,updated_at)
      VALUES(?,?,?,1,'published',1)`).bind(project, session, live),
    db.prepare(`INSERT INTO view_visible(project_id,instance_id,session_id,role,precedence)
      VALUES(?,?,?,'live',0)`).bind(project, live, session),
    ...(parent === undefined ? [] : [db.prepare(`INSERT INTO view_visible(project_id,instance_id,session_id,role,precedence)
      VALUES(?,?,?,'parent',1)`).bind(project, parent, session)]),
    db.prepare(`INSERT INTO fact_classes(project_id,table_name,record_id,session_id,class,classified_at)
      VALUES(?,'plans',?,?,'legacy',1)`).bind(project, uuid(50), session),
    db.prepare(`INSERT INTO plan_promotions(project_id,plan_key,session_id,instance_id,state,editor,promoted_at)
      VALUES(?,?,?,?,'done','editor',1)`).bind(project, uuid(50), session, live),
  ]);
}

export async function clearViewInstances(db: RelationalStore, project: string, session: string): Promise<void> {
  await db.batch(VIEW_SESSION_TABLES.map(table => db.prepare(`DELETE FROM ${table} WHERE project_id=? AND session_id=?`).bind(project, session)));
}

/** Copies exact captured identities into a synthetic instance. */
export async function mirrorViewSession(db: RelationalStore, value: SyntheticInstance, copyRows = true): Promise<void> {
  const { projectId, sessionId, instanceId, state, parent } = value;
  await db.prepare(`INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,parent_instance,state,created_at)
    VALUES(?,?,?,1,?,?,?,1)`).bind(projectId, instanceId, sessionId,
    parent === undefined ? (state === 'frozen' ? 'frozen' : 'full') : 'tail', parent ?? null, state).run();
  if (!copyRows) return;
  for (const material of VIEW_MATERIALS) {
    const table = material.table === 'view_prompts' ? 'prompt_batches' : material.table.slice('view_'.length);
    const original = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const view = await db.prepare(`PRAGMA table_info(${material.table})`).all<{ name: string }>();
    const originalColumns = new Set(original.results.map(row => row.name));
    const columns = view.results.map(row => row.name).filter(column => originalColumns.has(column));
    await db.prepare(`INSERT INTO ${material.table}(instance_id,source_transcript_id,source_offset,source_end,${columns.join(',')})
      SELECT ?,?,0,1,${columns.join(',')} FROM ${table} WHERE project_id=? AND session_id=?`)
      .bind(instanceId,instanceId+':source',projectId,sessionId).run();
    const fields=material.table==='view_tool_calls'?[['tool-input','input_blob_key'],['tool-output','output_blob_key']]
      :[[material.table==='view_prompts'?'prompt':material.table==='view_responses'?'response':'plan','blob_key']];
    for(const [kind,blob]of fields)await db.prepare(`INSERT INTO view_content_proofs(project_id,instance_id,session_id,kind,record_id,blob_key,digest,size,verified_at)
      SELECT p.project_id,?,p.session_id,?,p.${material.id},p.${blob},p.${blob},b.size,1 FROM ${table} p
        JOIN processed_resources proof ON proof.project_id=p.project_id AND proof.kind=? AND proof.resource_id=p.${material.id} AND proof.blob_key=p.${blob} AND proof.classification='processed'
        JOIN blobs b ON b.project_id=p.project_id AND b.key=p.${blob}
      WHERE p.project_id=? AND p.session_id=?`).bind(instanceId,kind,kind,projectId,sessionId).run();

  }
}

/** Synthetic publication classifies the session's original material as legacy. */
export async function publishMirroredSession(db: RelationalStore, project: string, session: string, live: string, parent?: string, backend:'synthetic'|'writer'=writerReadBackend()?'writer':'synthetic'): Promise<void> {
  const classifications=VIEW_MATERIALS.map(material => {
      const table = material.table === 'view_prompts' ? 'prompt_batches' : material.table.slice('view_'.length);
      return db.prepare(`INSERT INTO fact_classes(project_id,table_name,record_id,session_id,class,classified_at)
        SELECT project_id,?,${material.id},session_id,'legacy',1 FROM ${table} WHERE project_id=? AND session_id=?
        ON CONFLICT(project_id,table_name,record_id) DO NOTHING`).bind(table, project, session);
    });
  if(backend==='writer'){
   const current=await db.prepare('SELECT s.live_instance,i.parser_version FROM session_views s JOIN view_instances i ON i.project_id=s.project_id AND i.instance_id=s.live_instance WHERE s.project_id=? AND s.session_id=?').bind(project,session).first<{live_instance:string;parser_version:number}>();
   if(current?.parser_version===PARSER_VERSION&&current.live_instance!==live){await db.batch(classifications);await rebuildWriterMirror(db,project,session);return;}
  }
  await db.batch([
    db.prepare(`UPDATE view_instances SET state='retired',retired_at=1
      WHERE project_id=? AND session_id=? AND state='live' AND instance_id<>?`).bind(project, session, live),
    db.prepare(`UPDATE view_instances SET state='live',published_at=1,retired_at=NULL
      WHERE project_id=? AND instance_id=? AND session_id=?`).bind(project, live, session),
    db.prepare(`DELETE FROM view_visible WHERE project_id=? AND session_id=?`).bind(project, session),
    db.prepare(`INSERT INTO session_views(project_id,session_id,live_instance,fence,legacy,updated_at)
      VALUES(?,?,?,1,'published',1) ON CONFLICT(project_id,session_id)
      DO UPDATE SET live_instance=excluded.live_instance,fence=session_views.fence+1,legacy='published'`).bind(project, session, live),
    db.prepare(`INSERT INTO view_visible(project_id,instance_id,session_id,role,precedence) VALUES(?,?,?,'live',0)`).bind(project, live, session),
    ...(parent === undefined ? [] : [db.prepare(`INSERT INTO view_visible(project_id,instance_id,session_id,role,precedence)
      VALUES(?,?,?,'parent',1)`).bind(project, parent, session)]),
    ...classifications,
  ]);
  if(backend==='writer')await rebuildWriterMirror(db,project,session);
}

/** Checkpoint failures are stored on the named synthetic parser instance. */
export async function setViewCheckpointFailure(db:RelationalStore,project:string,session:string,instance:string,error:string|null):Promise<void>{
 await db.prepare(`INSERT INTO view_checkpoints(project_id,instance_id,session_id,transcript_id,ordinal,start_offset,parsed_offset,parse_error)
   VALUES(?,?,?,? ,0,0,1,?) ON CONFLICT(project_id,instance_id,transcript_id) DO UPDATE SET parse_error=excluded.parse_error`)
  .bind(project,instance,session,instance+':source',error).run();
}

/** Synthetic checkpoints expose cursor readiness and accepted loss independently. */
export async function setViewCheckpointProgress(db:RelationalStore,project:string,instance:string,transcript:string,offset:number,lost:number):Promise<void>{
 await db.prepare('UPDATE view_checkpoints SET transcript_id=?,parsed_offset=?,lost_context=? WHERE project_id=? AND instance_id=?')
  .bind(transcript,offset,lost,project,instance).run();
}

/** Header state controls are confined to synthetic instances. */
export async function setSyntheticInstanceState(db:RelationalStore,project:string,instance:string,state:typeof INSTANCE_STATES[number]):Promise<void>{
 await db.prepare('UPDATE view_instances SET state=? WHERE project_id=? AND instance_id=?').bind(state,project,instance).run();
}

/** Hidden synthetic instances copy the exact records of their named source instances. */
export async function appendViewCostHistory(db:RelationalStore,sources:readonly {
  projectId:string;sessionId:string;instanceId:string;
}[],from:number,through:number):Promise<void>{
  const states=['retired','building','failed','abandoned'] as const;
  const rows=Array.from({length:through-from},(_,offset)=>{
    const index=from+offset,source=sources[index%sources.length]!;
    return {...source,source:source.instanceId,instanceId:'hidden-'+index,state:states[index%states.length]};
  });
  const payload=JSON.stringify(rows);
  await db.prepare(`INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,state,created_at)
    SELECT json_extract(j.value,'$.projectId'),json_extract(j.value,'$.instanceId'),json_extract(j.value,'$.sessionId'),1,'full',json_extract(j.value,'$.state'),1
    FROM json_each(?) j`).bind(payload).run();
  for(const material of VIEW_MATERIALS){
    const columns=(await db.prepare('PRAGMA table_info('+material.table+')').all<{name:string}>()).results
      .map(row=>row.name).filter(name=>name!=='instance_id');
    await db.prepare(`INSERT INTO ${material.table}(instance_id,${columns.join(',')})
      SELECT json_extract(j.value,'$.instanceId'),${columns.map(column=>'source.'+column).join(',')}
      FROM json_each(?) j CROSS JOIN ${material.table} source
      WHERE source.project_id=json_extract(j.value,'$.projectId') AND source.instance_id=json_extract(j.value,'$.source')`)
      .bind(payload).run();
  }
}

/** Removes a stored source coordinate from one synthetic material row. */
export async function clearViewSourceIdentity(db:RelationalStore,project:string,instance:string):Promise<void>{
 await db.prepare('UPDATE view_plans SET source_transcript_id=NULL,source_offset=NULL,source_end=NULL WHERE project_id=? AND instance_id=?').bind(project,instance).run();
}

/** Complete session metadata supplies schema, tombstone and recovery fixtures. */
export async function seedViewWriterMetadata(db: RelationalStore, project: string, session: string, instance: string): Promise<void> {
 await db.batch([
  db.prepare(`INSERT INTO learning_sessions(project_id,session_id,next_seq,max_seq,revision) VALUES(?,?,2,1,1)`).bind(project,session),
  db.prepare(`INSERT INTO material_versions(project_id,session_id,kind,identity,record_id,content_hash,hash_scheme,material_seq)
    VALUES(?,?,'prompt','prompt','prompt','fixture-hash','fixture-scheme',1)`).bind(project,session),
  db.prepare(`INSERT INTO view_publication_material(project_id,session_id,attempt_id,kind,identity,record_id,content_hash,hash_scheme,ord,material_seq)
    VALUES(?,?,'fixture-attempt','prompt','prompt','prompt','fixture-hash','fixture-scheme',1,1)`).bind(project,session),
  db.prepare(`INSERT INTO view_build_work(project_id,session_id,instance_id,tier,session_created_at,started_at) VALUES(?,?,?,0,1,1)`).bind(project,session,instance),
  db.prepare(`INSERT INTO view_legacy_ack_feed(project_id,session_id,ack_id) VALUES(?,?,'fixture-ack')`).bind(project,session),
  db.prepare(`INSERT INTO view_work_samples(project_id,session_id,instance_id,started_at,initial_bytes,offered_bytes) VALUES(?,?,?,1,0,0)`).bind(project,session,instance),
 ]);
}

/** Frozen fixture inputs provide the accepted frontier for a real tail rebuild. */
const WRITER_COUNT_TURN='writer-count-turn';
export const writerReadPromptId=(sessionId:string)=>canonicalPromptId(uuidv5,{scheme:'codex-turn-v1',sessionId,turnId:WRITER_COUNT_TURN,submission:{opener:true}});
export async function rebuildWriterMirror(db:RelationalStore,project:string,session:string):Promise<void>{
 await withViewWriterDriver(async()=>{
  if(await db.prepare('SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?').bind(project,session).first())return;
  const received=await db.prepare('SELECT last_received_at FROM sessions WHERE project_id=? AND session_id=?').bind(project,session).first<{last_received_at:number}>();
  if(!received)throw new Error('Writer fixture has no session');
  const now=received.last_received_at;
  let current=await db.prepare(`SELECT s.live_instance,s.fence,i.parent_instance,i.parser_version FROM session_views s JOIN view_instances i ON i.project_id=s.project_id AND i.instance_id=s.live_instance WHERE s.project_id=? AND s.session_id=?`).bind(project,session).first<{live_instance:string;fence:number;parent_instance:string|null;parser_version:number}>();
  if(!current)throw new Error('Writer fixture has no frozen input');
  if(current.parser_version!==PARSER_VERSION&&current.parent_instance!==null){
   const parent=current.parent_instance??current.live_instance,tail='writer-base-'+current.live_instance;
   for(const material of VIEW_MATERIALS){
    const rows=(await db.prepare('SELECT * FROM '+material.table+' WHERE project_id=? AND instance_id=? AND canonical_identity IS NULL').bind(project,parent).all<Record<string,unknown>>()).results;
    const versions=await Promise.all(rows.map(async row=>({id:String(row[material.id]),identity:JSON.stringify(['frozen',material.kind,row[material.id]]),hash:await viewContentHash(material.kind,row)})));
    if(versions.length)await db.prepare(`UPDATE ${material.table} AS target SET canonical_identity=json_extract(j.value,'$.identity'),view_content_hash=json_extract(j.value,'$.hash'),hash_scheme='view-content-v1' FROM json_each(?) j WHERE target.project_id=? AND target.instance_id=? AND target.${material.id}=json_extract(j.value,'$.id')`).bind(JSON.stringify(versions),project,parent).run();
   }

   const bodyProofs=(await db.prepare('SELECT v.blob_key,v.size,v.digest,b.generation FROM view_content_proofs v JOIN blobs b ON b.project_id=v.project_id AND b.key=v.blob_key WHERE v.project_id=? AND v.instance_id=?').bind(project,parent).all<{blob_key:string;size:number;digest:string;generation:string|null}>()).results;
   for(const body of bodyProofs){
    await verifyContentObject({blobs:legacyBodyBlobs},blobObjectKey(project,body.blob_key,body.generation),body.size,body.digest);
    await db.prepare(`INSERT OR IGNORE INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable) VALUES(?,?,?,'view',?,?,?,?,?,?,?,1)`).bind(project,body.blob_key,body.generation,parent,parent,parent,session,body.digest,body.size,now).run();
   }
   await db.prepare("UPDATE view_instances SET state='frozen',base='frozen' WHERE project_id=? AND instance_id=?").bind(project,parent).run();
   await mirrorViewSession(db,{projectId:project,sessionId:session,instanceId:tail,state:'live',parent},false);
   await publishMirroredSession(db,project,session,tail,parent,'synthetic');
   await db.prepare(`INSERT INTO view_checkpoints(project_id,instance_id,session_id,transcript_id,ordinal,start_offset,parsed_offset,parser_version)
    SELECT project_id,?,session_id,transcript_id,row_number() OVER(ORDER BY transcript_id)-1,size,size,? FROM transcripts WHERE project_id=? AND session_id=?`)
    .bind(tail,PARSER_VERSION,project,session).run();
  }
  const prompt=await (current.parent_instance===null?
   db.prepare("SELECT prompt_id,text,created_at FROM prompt_batches WHERE project_id=? AND session_id=? AND text IS NOT NULL AND origin='user' ORDER BY created_at,prompt_id LIMIT 1").bind(project,session):
   db.prepare("SELECT prompt_id,text,created_at FROM view_prompts WHERE project_id=? AND session_id=? AND instance_id=? AND text IS NOT NULL AND origin='user' ORDER BY created_at,prompt_id LIMIT 1").bind(project,session,current.parent_instance)
  ).first<{prompt_id:string;text:string;created_at:number}>();
  const transcript='tx_'+(await sha256Hex(project+'#'+session+'#writer-proof')).slice(0,32);
  const exists=await db.prepare('SELECT 1 FROM transcripts WHERE project_id=? AND transcript_id=?').bind(project,transcript).first();
  const timestamp=new Date(prompt?.created_at??1).toISOString();
  const full=current.parent_instance===null;
  if(full&&!prompt)throw new Error('Writer count fixture has no prompt input');
  const payloads=[
   {type:'message',role:'user',content:[{type:'input_text',text:prompt?.text}]},
   {type:'function_call',call_id:'writer-read-tool',name:'Read',arguments:'{}'},
   {type:'function_call_output',call_id:'writer-read-tool',output:'writer count output'},
   {type:'message',role:'assistant',content:[{type:'output_text',text:'<proposed_plan>\n# Writer count plan\n- [ ] work\n</proposed_plan>'}]},
  ];
  const input=full?JSON.stringify({type:'turn_context',timestamp,payload:{turn_id:WRITER_COUNT_TURN}})+'\n'+payloads.map(payload=>JSON.stringify({type:'response_item',timestamp,payload})+'\n').join(''):
   prompt?JSON.stringify({v:1,type:'prompt',promptId:prompt.prompt_id,text:prompt.text,at:timestamp})+'\n':'{}\n';
  const env=exists?{db,blobs:legacyBodyBlobs}:await captureViewTranscript(db,legacyBodyBlobs,session,transcript,input,now,0,full?'codex':'opencode',project);
  current=await db.prepare(`SELECT s.live_instance,s.fence,i.parent_instance,i.parser_version FROM session_views s JOIN view_instances i ON i.project_id=s.project_id AND i.instance_id=s.live_instance WHERE s.project_id=? AND s.session_id=?`).bind(project,session).first<{live_instance:string;fence:number;parent_instance:string|null;parser_version:number}>();
  const id=await uuidv5('writer-read-proof',project,session,String(current!.fence));
  const isUuid=(value:string):value is ReturnType<typeof crypto.randomUUID>=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  if(!isUuid(id))throw new Error('Writer fixture UUID is invalid');
  const random=spyOn(crypto,'randomUUID').mockReturnValue(id);
  try{await requestViewRebuild(db,project,session,now);}finally{random.mockRestore()}
  const target=await claimViewBuild(db,project,session,SERIAL_VIEW_BUDGET,now);
  if(!target)throw new Error('Writer fixture build was not claimed');
  for(let pass=0;pass<32;pass++)if(await parseViewOnce(env,target,now,{calls:2000,deadline:Date.now()+15000,clock:Date.now,completeFile:true})===null)break;
  const published=await tryPublishView(db,target,now,fixtureFlipEnvelope());
  if(!published.published)throw new Error('Writer fixture did not publish: '+published.reason);
 });
}
