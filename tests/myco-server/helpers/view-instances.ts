import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { VIEW_MATERIALS, VIEW_SESSION_TABLES } from '@myco-server-worker/db/view-tables.js';
import { uuid } from './fixtures.js';

export const INSTANCE_STATES = ['building', 'live', 'frozen', 'retired', 'failed', 'abandoned'] as const;
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
export async function publishMirroredSession(db: RelationalStore, project: string, session: string, live: string, parent?: string): Promise<void> {
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
    ...VIEW_MATERIALS.map(material => {
      const table = material.table === 'view_prompts' ? 'prompt_batches' : material.table.slice('view_'.length);
      return db.prepare(`INSERT INTO fact_classes(project_id,table_name,record_id,session_id,class,classified_at)
        SELECT project_id,?,${material.id},session_id,'legacy',1 FROM ${table} WHERE project_id=? AND session_id=?
        ON CONFLICT(project_id,table_name,record_id) DO NOTHING`).bind(table, project, session);
    }),
  ]);
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
