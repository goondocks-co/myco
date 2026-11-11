/**
 * What a document commit tells the session's own rows: the plans its transcripts hold, the paths its tool calls touched
 * and the Myco tool calls it placed.
 */
import { TRANSCRIPT_PARSE_ADAPTER } from '../../constants.js';
import { write, type Bound } from '../index.js';
import type { DocumentKey } from './turn-statistics.js';

const savePlans = write<[project: string, session: string, token: string, now: number, plans: string]>({ name: 'documentRows.saveTranscriptPlans', sql: `INSERT INTO plans (project_id,plan_key,session_id,event_id,machine_id,title,content,blob_key,content_hash,status,origin_path,
    created_at,updated_at,token_id,received_at,prompt_id,source)
  SELECT ?1,json_extract(j.value,'$.key'),?2,json_extract(j.value,'$.id'),
    COALESCE((SELECT machine_id FROM sessions WHERE project_id=?1 AND session_id=?2),''),json_extract(j.value,'$.title'),
    json_extract(j.value,'$.content'),json_extract(j.value,'$.blob'),json_extract(j.value,'$.hash'),json_extract(j.value,'$.status'),json_extract(j.value,'$.path'),
    json_extract(j.value,'$.at'),json_extract(j.value,'$.at'),?3,?4,json_extract(j.value,'$.prompt'),json_extract(j.value,'$.source') FROM json_each(?5) j WHERE true
  ON CONFLICT (project_id,plan_key) DO UPDATE SET title=excluded.title,content=excluded.content,blob_key=excluded.blob_key,content_hash=excluded.content_hash,
    event_id=excluded.event_id,updated_at=excluded.updated_at,received_at=excluded.received_at
  WHERE (plans.event_id=plans.plan_key OR EXISTS (SELECT 1 FROM events e WHERE e.project_id=plans.project_id
      AND e.event_id=plans.event_id AND e.producer_adapter='${TRANSCRIPT_PARSE_ADAPTER}'))
    AND plans.updated_by IS NULL AND plans.updated_at<excluded.updated_at AND plans.content_hash<>excluded.content_hash` });
const provePlans = write<[project: string, plans: string]>({ name: 'documentRows.proveSpilledPlans', sql: `INSERT INTO processed_resources (project_id,kind,resource_id,blob_key,source_token_id,event_id)
  SELECT ?1,'plan',p.plan_key,p.blob_key,p.token_id,p.event_id FROM json_each(?2) j
    JOIN plans p ON p.project_id=?1 AND p.plan_key=json_extract(j.value,'$.key') AND p.blob_key=json_extract(j.value,'$.blob')
    JOIN blobs b ON b.project_id=p.project_id AND b.key=p.blob_key
  WHERE json_extract(j.value,'$.blob') IS NOT NULL ON CONFLICT DO NOTHING` });

/** A page of transcript plans saved, and the processed proof each spilled body's readers require. */
export function transcriptPlanWrites(project: string, session: string, token: string, now: number, plans: string): Bound[] {
  return [savePlans.bind(project, session, token, now, plans), provePlans.bind(project, plans)];
}

const shrinkPaths = write<[...DocumentKey, paths: string]>({ name: 'documentRows.shrinkPaths', sql: `UPDATE session_paths SET tool_calls=tool_calls+json_extract(j.value,'$.n'),edits=edits+json_extract(j.value,'$.edits'),
    last_turn=CASE WHEN json_extract(j.value,'$.at')>=last_at THEN json_extract(j.value,'$.turn') ELSE last_turn END,
    last_at=MAX(last_at,json_extract(j.value,'$.at')) FROM json_each(?4) j
  WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND session_paths.path=json_extract(j.value,'$.path')
    AND session_paths.path IN (SELECT json_extract(value,'$.path') FROM json_each(?4))` });
const dropEmptyPaths = write<[...DocumentKey, paths: string]>({ name: 'documentRows.dropEmptyPaths', sql: `DELETE FROM session_paths WHERE project_id=?1 AND session_id=?2 AND generation=?3
  AND path IN (SELECT json_extract(value,'$.path') FROM json_each(?4)) AND tool_calls<=0` });
const growPaths = write<[...DocumentKey, paths: string]>({ name: 'documentRows.growPaths', sql: `INSERT INTO session_paths (project_id,session_id,generation,path,tool_calls,last_at,edits,last_turn)
  SELECT ?1,?2,?3,json_extract(j.value,'$.path'),json_extract(j.value,'$.n'),json_extract(j.value,'$.at'),json_extract(j.value,'$.edits'),json_extract(j.value,'$.turn') FROM json_each(?4) j
    WHERE true
  ON CONFLICT (project_id,session_id,generation,path) DO UPDATE SET tool_calls=tool_calls+excluded.tool_calls,edits=edits+excluded.edits,
    last_turn=CASE WHEN excluded.last_at >= last_at THEN excluded.last_turn ELSE last_turn END,last_at=MAX(last_at,excluded.last_at)` });
const saveMycoCalls = write<[...DocumentKey, calls: string]>({ name: 'documentRows.saveMycoCalls', sql: `INSERT INTO myco_tool_calls (project_id,session_id,generation,tool_call_id,myco_tool,myco_op,success,created_at,harness)
  SELECT ?1,?2,?3,json_extract(value,'$.id'),json_extract(value,'$.tool'),json_extract(value,'$.op'),json_extract(value,'$.ok'),
    json_extract(value,'$.at'),json_extract(value,'$.harness') FROM json_each(?4) WHERE true
  ON CONFLICT (project_id,session_id,generation,tool_call_id) DO UPDATE SET myco_op=excluded.myco_op,success=excluded.success` });

/** A page of paths whose calls fell: their counts lowered, and those with none left removed. */
export const shrinkPathWrites = (key: DocumentKey, paths: string): Bound[] => [shrinkPaths.bind(...key, paths), dropEmptyPaths.bind(...key, paths)];
/** A page of paths whose calls grew. */
export const growPathsWrite = (key: DocumentKey, paths: string): Bound => growPaths.bind(...key, paths);
export const saveMycoCallsWrite = (key: DocumentKey, calls: string): Bound => saveMycoCalls.bind(...key, calls);
