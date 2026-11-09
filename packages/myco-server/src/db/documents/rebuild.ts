import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commit, read, readSet, write } from '../index.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { publicationPolicy } from '../../ingest/publication-policy.js';
import type { CatchupFamily } from '../projections/family.js';

const GENERATION_TABLES = ['session_chunks','session_pages','session_sealed_records','session_prompts','session_paths',
  'session_edit_paths','session_turn_entries','session_turn_totals','session_path_build','myco_tool_calls',
  'document_owners','document_continuations','document_plan_keys','document_metadata_ready','document_metadata_progress'] as const;
const retainedStart = (t:string) => `COALESCE((SELECT MIN(base_offset) FROM (
  SELECT MIN(base_offset) AS base_offset FROM transcript_segments WHERE project_id=${t}.project_id AND transcript_id=${t}.transcript_id
  UNION ALL SELECT MIN(base_offset) AS base_offset FROM raw_archive_refs WHERE project_id=${t}.project_id AND transcript_id=${t}.transcript_id
    AND source_kind='transcript' AND disposition='archived')),0)`;
const reset = (t:string,offset=retainedStart(t)) => `published_offset=${offset},segment_lines=0,open_prompt_id=NULL,unfinished=0,reply_unfinished=0,
  reply_latest_at=NULL,state='active',failure=NULL,diagnostic=NULL,awaited_size=NULL,placed_records=NULL,placed_digest=NULL,parser_version=0`;
const publicKeys = `SELECT json_extract(value,'$[1]') project_id,json_extract(value,'$[2]') transcript_id,json_extract(value,'$[3]') generation FROM json_each(?1)`;
const active = (version:number) => `SELECT DISTINCT d.project_id,d.session_id,d.generation FROM (${publicKeys}) k
  JOIN transcript_publication p ON (p.project_id,p.transcript_id,p.generation)=(k.project_id,k.transcript_id,k.generation)
  JOIN session_documents d ON (d.project_id,d.session_id,d.generation)=(p.project_id,p.session_id,p.generation)
  WHERE d.state='live' AND p.parser_version>0 AND p.parser_version<${version} AND p.state<>'failed'
    AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE (t.project_id,t.session_id)=(d.project_id,d.session_id))`;
const selected = (version:number) => `SELECT r.project_id,r.session_id,r.from_generation FROM document_rebuild_receipts r
  JOIN session_documents d ON (d.project_id,d.session_id,d.generation)=(r.project_id,r.session_id,r.from_generation)
  WHERE r.version=${version} AND (r.project_id,r.session_id) IN (SELECT project_id,session_id FROM (${active(version)}))`;

function rebuildStatements(version:number):string[] {
  const candidates=active(version), held=selected(version);
  const ready=`NOT EXISTS(SELECT 1 FROM (${candidates}) c JOIN session_documents d USING(project_id,session_id)
    WHERE d.restore_hold IS NOT NULL)`;
  const vacant=GENERATION_TABLES.map(table=>`NOT EXISTS(SELECT 1 FROM (${held}) s JOIN ${table} c
    ON (c.project_id,c.session_id,c.generation)=(s.project_id,s.session_id,s.from_generation+1))`).join(' AND ');
  return [
    `SELECT CASE WHEN ${ready} THEN 1 ELSE json_extract('[]','$[publication_rebuild_held]') END`,
    `INSERT INTO document_rebuild_receipts(project_id,session_id,version,from_generation)
      SELECT project_id,session_id,${version},generation FROM (${candidates}) WHERE true
      ON CONFLICT(project_id,session_id,version) DO UPDATE SET from_generation=excluded.from_generation,rebuilt=0
      WHERE document_rebuild_receipts.from_generation<>excluded.from_generation`,
    `SELECT CASE WHEN ${vacant} AND NOT EXISTS(SELECT 1 FROM (${held}) s JOIN transcript_publication p
      ON (p.project_id,p.session_id,p.generation)=(s.project_id,s.session_id,s.from_generation+1))
      THEN 1 ELSE json_extract('[]','$[publication_rebuild_generation_conflict]') END`,
    ...GENERATION_TABLES.map(table=>`UPDATE ${table} AS c SET generation=s.from_generation+1 FROM (${held}) s
      WHERE (c.project_id,c.session_id,c.generation)=(s.project_id,s.session_id,s.from_generation)`),
    `UPDATE transcript_publication AS p SET ${reset('p')} WHERE p.state<>'failed'
      AND (p.project_id,p.session_id,p.generation) IN (SELECT project_id,session_id,from_generation FROM (${held}))`,
    `WITH selected AS MATERIALIZED (SELECT DISTINCT s.project_id,s.session_id,s.from_generation FROM document_rebuild_receipts s
      JOIN session_documents d ON (d.project_id,d.session_id,d.generation)=(s.project_id,s.session_id,s.from_generation)
      WHERE s.version=${version} AND (s.project_id,s.session_id) IN (SELECT t.project_id,t.session_id FROM (${publicKeys}) k
        JOIN transcript_publication t ON (t.project_id,t.transcript_id,t.generation)=(k.project_id,k.transcript_id,k.generation)))
      UPDATE transcript_publication AS p SET generation=s.from_generation+1 FROM selected s
      WHERE (p.project_id,p.session_id,p.generation)=(s.project_id,s.session_id,s.from_generation)`,
    `UPDATE session_documents AS d SET generation=generation+1,due_at=0,publication_after=NULL,publication_scan_due=NULL
      WHERE EXISTS(SELECT 1 FROM document_rebuild_receipts r WHERE (r.project_id,r.session_id,r.from_generation)=(d.project_id,d.session_id,d.generation) AND r.version=${version})
        AND (d.project_id,d.session_id) IN (SELECT p.project_id,p.session_id FROM (${publicKeys}) k JOIN transcript_publication p
          ON (p.project_id,p.transcript_id,p.generation)=(k.project_id,k.transcript_id,k.generation+1))`,
  ];
}
function reopenStatements(version:number):string[] {
  const target=`SELECT p.project_id,p.transcript_id,p.generation FROM (${publicKeys}) k JOIN transcript_publication p
    ON (p.project_id,p.transcript_id,p.generation)=(k.project_id,k.transcript_id,k.generation)
    JOIN session_documents d ON (d.project_id,d.session_id,d.generation)=(p.project_id,p.session_id,p.generation)
    WHERE d.state='live' AND p.state='failed' AND p.failure IN ('event_refused','record_too_large') AND p.parser_version<${version}
      AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE (t.project_id,t.session_id)=(p.project_id,p.session_id))`;
  return [
    `UPDATE session_documents SET due_at=0 WHERE (project_id,session_id) IN (SELECT p.project_id,p.session_id FROM (${target}) k
      JOIN transcript_publication p ON (p.project_id,p.transcript_id,p.generation)=(k.project_id,k.transcript_id,k.generation))`,
    `UPDATE transcript_publication AS p SET ${reset('p')} WHERE (p.project_id,p.transcript_id,p.generation) IN (${target})`,
  ];
}
const versionSource=(version:number,reopen:boolean)=>({
  table:`transcript_publication p INDEXED BY ${reopen?'idx_publication_reopen':'idx_publication_version'} JOIN session_documents d
    ON (d.project_id,d.session_id,d.generation)=(p.project_id,p.session_id,p.generation)`,
  columns:['p.parser_version','p.project_id','p.transcript_id','p.generation'],
  where:`p.parser_version${reopen?'>=':'>'}0 AND p.parser_version<${version} AND d.state='live'${reopen?" AND p.state='failed' AND p.failure IN ('event_refused','record_too_large')":" AND p.state<>'failed'"}`,
  pageSize:1, startKey:[0,'','',0],
});
const VERSION_PHASE_SOURCES = {
  publicationRebuildV6:versionSource(6,false),publicationReopenV6:versionSource(6,true),
};
const reconcile = (name:string,sqls:readonly string[]) => sqls.map((sql,i)=>(sql.startsWith('SELECT')?assertion<[string]>:write<[string]>)({name:`publication.${name}${i}`,sql}));
/** A versioned rebuild and a failed-frontier reopen use the same bounded catch-up protocol. */
export const PUBLICATION_VERSION_CATCHUP = {
  projection:'publication_version',
  phases:{
    publicationRebuildV6:{source:VERSION_PHASE_SOURCES.publicationRebuildV6,reconcile:reconcile('rebuildV6',rebuildStatements(6))},
    publicationReopenV6:{source:VERSION_PHASE_SOURCES.publicationReopenV6,reconcile:reconcile('reopenV6',reopenStatements(6))},
  },
} as const satisfies CatchupFamily;
export function publicationRebuildSchema():string[] {
  return [
    'CREATE INDEX IF NOT EXISTS idx_publication_version ON transcript_publication(parser_version,project_id,transcript_id,generation)',
    `CREATE TABLE IF NOT EXISTS document_rebuild_receipts(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,
      version INTEGER NOT NULL,from_generation INTEGER NOT NULL,rebuilt INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,session_id,version)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_document_rebuild_generation ON document_rebuild_receipts(project_id,session_id,from_generation)',
    'CREATE TABLE IF NOT EXISTS document_rebuild_totals(version INTEGER PRIMARY KEY,total INTEGER NOT NULL,rebuilt INTEGER NOT NULL)',
    `CREATE TRIGGER IF NOT EXISTS document_rebuild_receipt_insert AFTER INSERT ON document_rebuild_receipts BEGIN
      INSERT INTO document_rebuild_totals(version,total,rebuilt) VALUES(NEW.version,1,NEW.rebuilt)
      ON CONFLICT(version) DO UPDATE SET total=total+1,rebuilt=rebuilt+excluded.rebuilt; END`,
    `CREATE TRIGGER IF NOT EXISTS document_rebuild_receipt_delete AFTER DELETE ON document_rebuild_receipts BEGIN
      UPDATE document_rebuild_totals SET total=total-1,rebuilt=rebuilt-OLD.rebuilt WHERE version=OLD.version;
      DELETE FROM document_rebuild_totals WHERE version=OLD.version AND total=0; END`,
    `CREATE TRIGGER IF NOT EXISTS document_rebuild_receipt_update AFTER UPDATE OF rebuilt ON document_rebuild_receipts
      WHEN OLD.rebuilt<>NEW.rebuilt BEGIN UPDATE document_rebuild_totals SET rebuilt=rebuilt+NEW.rebuilt-OLD.rebuilt WHERE version=NEW.version; END`,
    `CREATE TRIGGER IF NOT EXISTS document_rebuild_settled AFTER UPDATE OF due_at ON session_documents WHEN NEW.due_at IS NULL
      BEGIN UPDATE document_rebuild_receipts SET rebuilt=1 WHERE project_id=NEW.project_id AND session_id=NEW.session_id
        AND from_generation+1=NEW.generation AND rebuilt=0; END`,
    ...Object.entries(VERSION_PHASE_SOURCES).map(([phase,source])=>`INSERT INTO projection_catchup(projection,phase,done)
      SELECT 'publication_version','${phase}',NOT EXISTS(SELECT 1 FROM ${source.table} WHERE ${source.where}) ON CONFLICT DO NOTHING`),
  ];
}
const progress=read<[],{version:number;total:number;rebuilt:number}>({name:'publication.rebuildProgress',sql:'SELECT version,total,rebuilt FROM document_rebuild_totals ORDER BY version'});
const phases=read<[],{done:number}>({name:'publication.rebuildReadiness',sql:"SELECT done FROM projection_catchup WHERE projection='publication_version'"});
export async function publicationRebuildProgress(db:RelationalStore) {
  const [state,rows]=await readSet(db,phases.bind(),progress.bind());
  return {state:state.length===2&&state.every(row=>row.done===1)&&rows.every(row=>row.rebuilt===row.total)?'ready' as const:'building' as const,versions:rows};
}

export type RereadSelector={agent:string}|{projectId:string;sessionId:string};
const policy=publicationPolicy('t.prompt_identity_scheme');
function rereadOperations(name:string,predicate:string) {
  return {
    replay:write<string[],{transcript_id:string}>({name:'publication.reread'+name,sql:`INSERT INTO transcript_publication
  (project_id,transcript_id,generation,session_id,published_offset,prompt_scheme,record_scheme,parser_version,updated_at)
  SELECT t.project_id,t.transcript_id,d.generation,t.session_id,${retainedStart('t')},${policy.prompt},${policy.record},0,0
  FROM transcripts t JOIN session_documents d ON (d.project_id,d.session_id)=(t.project_id,t.session_id)
  WHERE d.state='live' AND ${predicate}
    AND NOT EXISTS(SELECT 1 FROM session_tombstones z WHERE (z.project_id,z.session_id)=(t.project_id,t.session_id))
  ON CONFLICT(project_id,transcript_id,generation) DO UPDATE SET ${reset('transcript_publication','excluded.published_offset')},
    prompt_scheme=COALESCE(transcript_publication.prompt_scheme,excluded.prompt_scheme) RETURNING transcript_id`}),
    arm:write<string[]>({name:'publication.armReread'+name,sql:`UPDATE session_documents AS d SET due_at=0
      WHERE (d.project_id,d.session_id) IN (SELECT t.project_id,t.session_id FROM transcripts t WHERE ${predicate})
        AND d.state='live' AND NOT EXISTS(SELECT 1 FROM session_tombstones z WHERE (z.project_id,z.session_id)=(d.project_id,d.session_id))`}),
  };
}
const rereadSession=rereadOperations('Session','t.project_id=?1 AND t.session_id=?2');
const rereadAgent=rereadOperations('Agent','t.agent=?1');
/** Owner-requested rereads retain the current document and replay the same pinned canonical identities. */
export async function rereadTranscripts(db:RelationalStore,selector:RereadSelector):Promise<number> {
  const operations='agent'in selector?rereadAgent:rereadSession;
  const params='agent'in selector?[selector.agent]:[selector.projectId,selector.sessionId];
  const [result]=await commit(db,operations.replay.bind(...params),operations.arm.bind(...params));
  return result.results.length;
}
