import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { assertion, write } from '../index.js';
import { pinDecision } from './pins.js';
import { publicationPolicy } from '../../ingest/publication-policy.js';
import { jsonKeys } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';

const columns=['session_id','agent','prompt_identity_scheme','record_identity_scheme','role','read_before'];
function reconcilePublicationPins(keys:string):string[] {
  const source=`SELECT t.project_id,t.transcript_id,t.session_id,COALESCE(t.agent,'') agent,
    COALESCE(t.prompt_identity_scheme,'') prompt_identity_scheme,t.record_identity_scheme,COALESCE(t.role,'') role,
    (t.prompt_identity_scheme IS NULL AND (t.parser_version>0 OR t.parsed_at IS NOT NULL OR t.parsed_offset>0)) read_before
    FROM (${keys}) k CROSS JOIN transcripts t ON (t.project_id,t.transcript_id)=(k.project_id,k.transcript_id)`;
  return [
    `DELETE FROM document_transcript_pins WHERE (project_id,transcript_id) IN (${keys})
      AND NOT EXISTS(SELECT 1 FROM transcripts t WHERE (t.project_id,t.transcript_id)=(document_transcript_pins.project_id,document_transcript_pins.transcript_id))`,
    `INSERT INTO document_transcript_pins(project_id,transcript_id,${columns.join(',')}) SELECT project_id,transcript_id,${columns.join(',')} FROM (${source}) WHERE true
      ON CONFLICT(project_id,transcript_id) DO UPDATE SET ${columns.map(c=>`${c}=excluded.${c}`).join(',')}
      WHERE (${columns.map(c=>`document_transcript_pins.${c}`).join(',')}) IS NOT (${columns.map(c=>`excluded.${c}`).join(',')})`,
  ];
}
const pinGroup=(row:string)=>`INSERT INTO document_group_pins(project_id,session_id,agent,scheme,conflict,read_before)
  VALUES(${row}.project_id,${row}.session_id,${row}.agent,NULLIF(${row}.prompt_identity_scheme,''),0,${row}.read_before)
  ON CONFLICT(project_id,session_id,agent) DO UPDATE SET scheme=COALESCE(scheme,excluded.scheme),
    conflict=conflict OR (scheme IS NOT NULL AND excluded.scheme IS NOT NULL AND scheme<>excluded.scheme),
    read_before=MAX(read_before,excluded.read_before)
  WHERE (scheme IS NULL AND excluded.scheme IS NOT NULL) OR (conflict=0 AND scheme IS NOT NULL AND excluded.scheme IS NOT NULL AND scheme<>excluded.scheme)
    OR read_before<excluded.read_before;`;
const total=(row:string,sign:number)=>`INSERT INTO document_pin_totals(project_id,session_id,role,prompt_identity_scheme,transcripts)
  VALUES(${row}.project_id,${row}.session_id,${row}.role,${row}.prompt_identity_scheme,${sign})
  ON CONFLICT(project_id,session_id,role,prompt_identity_scheme) DO UPDATE SET transcripts=transcripts+excluded.transcripts;
  DELETE FROM document_pin_totals WHERE (project_id,session_id,role,prompt_identity_scheme)=(${row}.project_id,${row}.session_id,${row}.role,${row}.prompt_identity_scheme) AND transcripts=0;`;

export function publicationPinSchema():string[] {
  const project=`project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR})`;
  const statements=[
    `CREATE TABLE IF NOT EXISTS document_transcript_pins(${project},transcript_id TEXT NOT NULL,session_id TEXT NOT NULL,agent TEXT NOT NULL,
      prompt_identity_scheme TEXT NOT NULL,record_identity_scheme TEXT NOT NULL,role TEXT NOT NULL,read_before INTEGER NOT NULL,
      PRIMARY KEY(project_id,transcript_id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS document_group_pins(${project},session_id TEXT NOT NULL,agent TEXT NOT NULL,scheme TEXT,conflict INTEGER NOT NULL,read_before INTEGER NOT NULL,
      PRIMARY KEY(project_id,session_id,agent)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS document_pin_totals(${project},session_id TEXT NOT NULL,role TEXT NOT NULL,prompt_identity_scheme TEXT NOT NULL,transcripts INTEGER NOT NULL,
      PRIMARY KEY(project_id,session_id,role,prompt_identity_scheme)) WITHOUT ROWID`,
  ];
  for(const action of ['insert','update','delete']){
    const rows=action==='insert'?['NEW']:action==='delete'?['OLD']:['OLD','NEW'];
    statements.push(`CREATE TRIGGER IF NOT EXISTS document_pin_contribution_${action} AFTER ${action.toUpperCase()} ON document_transcript_pins
      BEGIN ${rows.map(row=>total(row,row==='OLD'?-1:1)).join('')} ${action==='delete'?'':pinGroup('NEW')} END`);
    const event=action==='update'?'UPDATE OF project_id,transcript_id,session_id,agent,prompt_identity_scheme,record_identity_scheme,role,parser_version,parsed_at,parsed_offset':action.toUpperCase();
    statements.push(`CREATE TRIGGER IF NOT EXISTS document_pin_source_${action} AFTER ${event} ON transcripts
      BEGIN ${rows.flatMap(row=>reconcilePublicationPins(`SELECT ${row}.project_id project_id,${row}.transcript_id transcript_id`)).join(';')}; END`);
  }
  for(const phase of ['publicationPinGroups','publicationPinsReady'])statements.push(`INSERT INTO projection_catchup(projection,phase,done)
    SELECT 'publication_pins','${phase}',NOT EXISTS(SELECT 1 FROM transcripts) ON CONFLICT DO NOTHING`);
  return statements;
}
const keys=jsonKeys(['project_id','transcript_id']);
const PIN_SOURCE={table:'transcripts',columns:['project_id','transcript_id']};
const PIN_ADMISSION_SOURCE={...PIN_SOURCE,where:'prompt_identity_scheme IS NULL'};
const PIN_RECONCILE=reconcilePublicationPins(keys).map((sql,i)=>write<[string]>({name:`publication.pinPage${i}`,sql}));
const PIN_GROUPS_READY=assertion<[]>({name:'publication.pinGroupsInitialized',sql:`SELECT CASE WHEN EXISTS(
  SELECT 1 FROM projection_catchup WHERE projection='publication_pins' AND phase='publicationPinGroups' AND done=1)
  THEN 1 ELSE json_extract('[]','$[publication_pins_building]') END`});
const policy=publicationPolicy('t.prompt_identity_scheme');
const PIN_ADMISSION_RECONCILE=[
  write<[string]>({name:'publication.admitPendingPins',sql:`UPDATE transcripts AS t SET prompt_identity_scheme=(SELECT ${pinDecision('t.agent')}
    FROM (SELECT 1) LEFT JOIN document_group_pins g ON (g.project_id,g.session_id,g.agent)=(t.project_id,t.session_id,COALESCE(t.agent,'')))
    WHERE (project_id,transcript_id) IN (${keys}) AND prompt_identity_scheme IS NULL
      AND NOT EXISTS(SELECT 1 FROM session_tombstones d WHERE (d.project_id,d.session_id)=(t.project_id,t.session_id))`}),
  write<[string]>({name:'publication.resumePinnedFrontiers',sql:`UPDATE transcript_publication AS p SET prompt_scheme=(SELECT ${policy.prompt}
      FROM transcripts t WHERE (t.project_id,t.transcript_id)=(p.project_id,p.transcript_id)),state='active',failure=NULL,diagnostic=NULL
    WHERE (p.project_id,p.transcript_id) IN (${keys}) AND p.prompt_scheme IS NULL
      AND (p.state='active' OR (p.failure='parse' AND json_extract(p.diagnostic,'$.branch')='scheme_conflict'))
      AND EXISTS(SELECT 1 FROM transcripts t JOIN session_documents d ON (d.project_id,d.session_id,d.generation)=(p.project_id,p.session_id,p.generation)
        WHERE (t.project_id,t.transcript_id)=(p.project_id,p.transcript_id) AND t.prompt_identity_scheme IS NOT NULL AND d.state='live')
      AND NOT EXISTS(SELECT 1 FROM session_tombstones z WHERE (z.project_id,z.session_id)=(p.project_id,p.session_id))`}),
  write<[string]>({name:'publication.armPinnedSessions',sql:`UPDATE session_documents SET due_at=0 WHERE (project_id,session_id) IN
    (SELECT t.project_id,t.session_id FROM (${keys}) k JOIN transcripts t ON (t.project_id,t.transcript_id)=(k.project_id,k.transcript_id)
      WHERE t.prompt_identity_scheme IS NOT NULL) AND state='live'
      AND NOT EXISTS(SELECT 1 FROM session_tombstones z WHERE (z.project_id,z.session_id)=(session_documents.project_id,session_documents.session_id))`}),
];
export const PUBLICATION_PIN_CATCHUP={
  projection:'publication_pins',
  phases:{
    publicationPinGroups:{source:PIN_SOURCE,reconcile:PIN_RECONCILE},
    publicationPinsReady:{source:PIN_ADMISSION_SOURCE,reconcile:PIN_ADMISSION_RECONCILE,frontier:()=>[PIN_GROUPS_READY.bind()]},
  },
} as const satisfies CatchupFamily;
