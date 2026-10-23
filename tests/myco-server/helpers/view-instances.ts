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
