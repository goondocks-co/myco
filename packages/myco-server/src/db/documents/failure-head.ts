import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { read, readSet, write } from '../index.js';
import type { RelationalStore } from '../../core/adapters.js';

const fields = ['session_id', 'failure', 'updated_at', 'diagnostic'] as const;
const key = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.transcript_id AS transcript_id,${row}.generation AS generation`;

/** Each contribution names a stopped transcript in the current visible document generation. */
export function reconcilePublicationFailures(keys: string): string[] {
  const source = `SELECT p.project_id,p.transcript_id,p.generation,p.session_id,COALESCE(p.failure,'unknown') AS failure,p.updated_at,p.diagnostic
    FROM (${keys}) k CROSS JOIN transcript_publication p ON (p.project_id,p.transcript_id,p.generation)=(k.project_id,k.transcript_id,k.generation)
    JOIN session_documents d ON (d.project_id,d.session_id,d.generation)=(p.project_id,p.session_id,p.generation) AND d.state='live'
    WHERE p.state='failed' AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE (t.project_id,t.session_id)=(p.project_id,p.session_id))`;
  return [
    `DELETE FROM document_failure_contributions WHERE (project_id,transcript_id,generation) IN (${keys})
      AND NOT EXISTS (SELECT 1 FROM (${source}) s WHERE (s.project_id,s.transcript_id,s.generation)=
        (document_failure_contributions.project_id,document_failure_contributions.transcript_id,document_failure_contributions.generation))`,
    `INSERT INTO document_failure_contributions(project_id,transcript_id,generation,${fields.join(',')})
      SELECT project_id,transcript_id,generation,${fields.join(',')} FROM (${source}) WHERE true
      ON CONFLICT(project_id,transcript_id,generation) DO UPDATE SET ${fields.map(c=>`${c}=excluded.${c}`).join(',')}
      WHERE (${fields.map(c=>`document_failure_contributions.${c}`).join(',')}) IS NOT (${fields.map(c=>`excluded.${c}`).join(',')})`,
  ];
}

const sessionKeys = (row: string, generation: string) => `SELECT project_id,transcript_id,generation FROM transcript_publication
  WHERE (project_id,session_id,generation)=(${row}.project_id,${row}.session_id,${generation})
  UNION SELECT project_id,transcript_id,generation FROM document_failure_contributions
  WHERE (project_id,session_id)=(${row}.project_id,${row}.session_id)`;
const newest = (row: string) => `SELECT updated_at,diagnostic FROM document_failure_contributions
  WHERE (project_id,failure)=(${row}.project_id,${row}.failure) ORDER BY updated_at DESC,transcript_id DESC,generation DESC LIMIT 1`;
const delta = (row: string, sign: number) => `INSERT INTO document_failure_totals(project_id,failure,transcripts,latest_at,diagnostic,visible)
  SELECT ${row}.project_id,${row}.failure,${sign},${row}.updated_at,${row}.diagnostic,
    EXISTS(SELECT 1 FROM projects WHERE project_id=${row}.project_id AND archived_at IS NULL)
  ON CONFLICT(project_id,failure) DO UPDATE SET transcripts=transcripts+excluded.transcripts;
  UPDATE document_failure_totals SET (latest_at,diagnostic)=(SELECT updated_at,diagnostic FROM (${newest(row)}))
    WHERE (project_id,failure)=(${row}.project_id,${row}.failure);
  DELETE FROM document_failure_totals WHERE (project_id,failure)=(${row}.project_id,${row}.failure) AND transcripts=0;`;
const latestHead = `SELECT latest_at,failure FROM document_failure_totals WHERE visible=1 AND transcripts>0 ORDER BY latest_at DESC,project_id DESC,failure DESC LIMIT 1`;

/** Frozen into the publication step; catch-up reuses the keyed contribution reconcile. */
export function publicationFailureSchema(): string[] {
  const statements = [
    `CREATE TABLE IF NOT EXISTS document_failure_contributions(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
      transcript_id TEXT NOT NULL,generation INTEGER NOT NULL,session_id TEXT NOT NULL,failure TEXT NOT NULL,
      updated_at INTEGER NOT NULL,diagnostic TEXT,PRIMARY KEY(project_id,transcript_id,generation)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_document_failure_session ON document_failure_contributions(project_id,session_id,generation)',
    'CREATE INDEX IF NOT EXISTS idx_document_failure_latest ON document_failure_contributions(project_id,failure,updated_at DESC,transcript_id DESC,generation DESC)',
    `CREATE TABLE IF NOT EXISTS document_failure_totals(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),failure TEXT NOT NULL,
      transcripts INTEGER NOT NULL,latest_at INTEGER,diagnostic TEXT,visible INTEGER NOT NULL,PRIMARY KEY(project_id,failure)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_document_failure_visible ON document_failure_totals(latest_at DESC,project_id DESC,failure DESC) WHERE visible=1 AND transcripts>0',
    `CREATE TABLE IF NOT EXISTS document_failure_head(slot INTEGER PRIMARY KEY CHECK(slot=1),transcripts INTEGER NOT NULL DEFAULT 0,
      latest_at INTEGER,failure TEXT,pass_failure TEXT)`,
  ];
  for (const action of ['insert','update','delete']) {
    const rows = action==='insert'?['NEW']:action==='delete'?['OLD']:['OLD','NEW'];
    statements.push(`CREATE TRIGGER IF NOT EXISTS document_failure_contribution_${action} AFTER ${action.toUpperCase()} ON document_failure_contributions
      BEGIN ${rows.map(row=>delta(row,row==='OLD'?-1:1)).join('\n')} END`);
    statements.push(`CREATE TRIGGER IF NOT EXISTS document_failure_total_${action} AFTER ${action.toUpperCase()} ON document_failure_totals
      BEGIN INSERT INTO document_failure_head(slot,transcripts) VALUES(1,${rows.map(row=>`${row==='OLD'?'-':''}${row}.visible*${row}.transcripts`).join('+')})
        ON CONFLICT(slot) DO UPDATE SET transcripts=transcripts+excluded.transcripts;
        UPDATE document_failure_head SET (latest_at,failure)=(SELECT latest_at,failure FROM (${latestHead})) WHERE slot=1; END`);
    const update = action==='update'?'UPDATE OF project_id,transcript_id,generation,session_id,state,failure,updated_at,diagnostic':action.toUpperCase();
    statements.push(`CREATE TRIGGER IF NOT EXISTS document_failure_publication_${action} AFTER ${update} ON transcript_publication
      BEGIN ${rows.flatMap(row=>reconcilePublicationFailures(key(row))).join(';')} ; END`);
    const docUpdate = action==='update'?'UPDATE OF project_id,session_id,state,generation':action.toUpperCase();
    statements.push(`CREATE TRIGGER IF NOT EXISTS document_failure_document_${action} AFTER ${docUpdate} ON session_documents${action==='update'? '\n      WHEN (OLD.project_id,OLD.session_id,OLD.state,OLD.generation) IS NOT (NEW.project_id,NEW.session_id,NEW.state,NEW.generation)' : ''}
      BEGIN ${rows.flatMap(row=>reconcilePublicationFailures(sessionKeys(row,`${row}.generation`))).join(';')} ; END`);
  }
  for (const action of ['insert','delete']) {
    const row=action==='insert'?'NEW':'OLD';
    statements.push(`CREATE TRIGGER IF NOT EXISTS document_failure_tombstone_${action} AFTER ${action.toUpperCase()} ON session_tombstones
      BEGIN ${reconcilePublicationFailures(sessionKeys(row,`(SELECT generation FROM session_documents WHERE project_id=${row}.project_id AND session_id=${row}.session_id)`)).join(';')} ; END`);
  }
  for (const action of ['insert','update','delete']) {
    const row=action==='delete'?'OLD':'NEW';
    statements.push(`CREATE TRIGGER IF NOT EXISTS document_failure_project_${action} AFTER ${action==='update'?'UPDATE OF archived_at':action.toUpperCase()} ON projects
      BEGIN UPDATE document_failure_totals SET visible=${action==='delete'?'0':'NEW.archived_at IS NULL'} WHERE project_id=${row}.project_id; END`);
  }
  statements.push(`INSERT INTO projection_catchup(projection,phase,done) SELECT 'publication_failures','publicationFailures',
    NOT EXISTS(SELECT 1 FROM transcript_publication WHERE state='failed') ON CONFLICT DO NOTHING`);
  statements.push(`INSERT INTO projection_catchup(projection,phase,done) SELECT 'publication_failures','publicationFailureRecord',
    NOT EXISTS(SELECT 1 FROM schema_meta WHERE key='attention.document_publish_failure') ON CONFLICT DO NOTHING`);
  return statements;
}

export const FAILURE_PHASE_SOURCE = { table: 'transcript_publication', columns: ['project_id','transcript_id','generation'] };
export const FAILURE_RECONCILE = reconcilePublicationFailures(`SELECT json_extract(value,'$[0]') project_id,
  json_extract(value,'$[1]') transcript_id,json_extract(value,'$[2]') generation FROM json_each(?1)`)
  .map((sql,i)=>write<[string]>({name:`publication.failurePage${i}`,sql}));

export interface FailureTotal { project_id:string; failure:string; transcripts:number; latest_at:number; diagnostic:string|null }
const readiness = read<[],{done:number}>({name:'publication.failureReadiness',sql:"SELECT done FROM projection_catchup WHERE projection='publication_failures' AND phase='publicationFailures'"});
const totals = read<[],FailureTotal>({name:'publication.failureTotals',sql:'SELECT project_id,failure,transcripts,latest_at,diagnostic FROM document_failure_totals WHERE visible=1 AND transcripts>0 ORDER BY project_id,failure'});
const head = read<[],{transcripts:number;latest_at:number|null;failure:string|null}>({name:'publication.failureHead',sql:'SELECT transcripts,latest_at,failure FROM document_failure_head WHERE slot=1'});
export async function publicationFailureTotals(db:RelationalStore) {
  const [phases,rows]=await readSet(db,readiness.bind(),totals.bind());
  return phases[0]?.done===1?{state:'ready' as const,rows}:{state:'building' as const};
}
export async function publicationFailureHead(db:RelationalStore) {
  const [phases,rows]=await readSet(db,readiness.bind(),head.bind());
  return phases[0]?.done===1?{state:'ready' as const,head:rows[0]??null}:{state:'building' as const};
}

const previousPass = `COALESCE((SELECT pass_failure FROM document_failure_head WHERE slot=1),
  (SELECT value FROM schema_meta WHERE key='attention.document_publish_failure'))`;
const recordPass = write<[string, number]>({name:'publication.recordPassFailure',sql:`INSERT INTO document_failure_head(slot,pass_failure)
  SELECT 1,json_set(?1,'$.count',CASE WHEN json_extract(${previousPass},'$.last_failed_at')>=?2
    THEN json_extract(${previousPass},'$.count')+1 ELSE 1 END)
  ON CONFLICT(slot) DO UPDATE SET pass_failure=excluded.pass_failure`});
export const FAILURE_RECORD_SOURCE = {table:'schema_meta',columns:['key'],where:"key='attention.document_publish_failure'"};
export const FAILURE_RECORD_RECONCILE = [
  write<[string]>({name:'publication.importFailureRecord',sql:`INSERT INTO document_failure_head(slot,pass_failure)
    SELECT 1,m.value FROM json_each(?1) j JOIN schema_meta m ON m.key=json_extract(j.value,'$[0]')
    WHERE m.key='attention.document_publish_failure' ON CONFLICT(slot) DO UPDATE SET pass_failure=excluded.pass_failure
      WHERE document_failure_head.pass_failure IS NULL`}),
  write<[string]>({name:'publication.retireFailureRecord',sql:`DELETE FROM schema_meta WHERE key='attention.document_publish_failure'
    AND key IN (SELECT json_extract(value,'$[0]') FROM json_each(?1))
    AND EXISTS(SELECT 1 FROM document_failure_head WHERE slot=1 AND pass_failure IS NOT NULL)`}),
];
export const documentPassFailure = (sample:{projectId:string;sessionId:string;failure:string},now:number,since:number) =>
  recordPass.bind(JSON.stringify({count:1,last_failed_at:now,sample}),since);

const metadata = read<[], {value:string;pass_failure:string|null}>({name:'publication.statusMetadata',sql:`SELECT value,
  ${previousPass} AS pass_failure FROM schema_meta WHERE key='version'`});
export interface StatusMetadata { version:number|null; documentPublishFailure:string|null }
export async function statusMetadata(db:RelationalStore):Promise<StatusMetadata> {
  const [rows]=await readSet(db,metadata.bind());
  const row=rows[0];
  return {version:row===undefined?null:Number(row.value),documentPublishFailure:row?.pass_failure??null};
}
