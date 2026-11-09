import { prepareBound } from '../kernel/statement.js';
import type { RelationalStore, PreparedStatement } from '../../core/adapters.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { assertion, read, readSet, refusalCode, write, type Bound } from '../index.js';
import { jsonPages } from '../json-pages.js';

export class PublicationOwnershipBuilding extends Error {
  constructor(readonly failure:string|null=null) { super(failure??'publication_ownership_building'); }
}

export interface KeyOwner { thread:string; record:string }
export interface MetadataShard { chunkNo:number; states:readonly string[]; owners:readonly [string,KeyOwner][]; plans:readonly string[] }
type Scope = [string,string,number];
const ready=read<Scope,{tail_separated:number;failure:string|null}>({name:'publication.ownershipReady',sql:'SELECT tail_separated,failure FROM document_metadata_ready WHERE project_id=? AND session_id=? AND generation=?'});
const owners=read<[...Scope,string],{source_key:string;source_thread:string;source_record:string}>({name:'publication.owners',sql:`SELECT o.source_key,o.source_thread,o.source_record
  FROM json_each(?4) j CROSS JOIN document_owners o ON (o.project_id,o.session_id,o.generation,o.source_key)=(?1,?2,?3,j.value)`});
const state=read<[...Scope,string],{chunk_no:number}>({name:'publication.continuation',sql:'SELECT chunk_no FROM document_continuations WHERE project_id=? AND session_id=? AND generation=? AND transcript_id=?'});
const plans=read<[...Scope,string],{plan_key:string}>({name:'publication.planKeys',sql:`SELECT p.plan_key FROM json_each(?4) j CROSS JOIN document_plan_keys p
  ON (p.project_id,p.session_id,p.generation,p.plan_key)=(?1,?2,?3,j.value)`});
const ownerWrite=write<[...Scope,string]>({name:'publication.claimOwners',sql:`INSERT INTO document_owners(project_id,session_id,generation,source_key,source_thread,source_record)
  SELECT ?1,?2,?3,json_extract(value,'$[0]'),json_extract(value,'$[1].thread'),json_extract(value,'$[1].record') FROM json_each(?4) WHERE true ON CONFLICT DO NOTHING`});
export const DOCUMENT_OWNERSHIP_CONFLICT=refusalCode('document_ownership_conflict');
const ownerGuard=assertion<[...Scope,string]>({name:'publication.ownersUnchanged',refusal:DOCUMENT_OWNERSHIP_CONFLICT,when:`NOT EXISTS(SELECT 1 FROM json_each(?4) j CROSS JOIN document_owners o
  ON (o.project_id,o.session_id,o.generation,o.source_key)=(?1,?2,?3,json_extract(j.value,'$[0]'))
  WHERE (o.source_thread,o.source_record) IS NOT (json_extract(j.value,'$[1].thread'),json_extract(j.value,'$[1].record')))`});
const stateWrite=write<[...Scope,number,string]>({name:'publication.saveContinuations',sql:`INSERT INTO document_continuations(project_id,session_id,generation,transcript_id,chunk_no)
  SELECT ?1,?2,?3,value,?4 FROM json_each(?5) WHERE true ON CONFLICT(project_id,session_id,generation,transcript_id) DO UPDATE SET chunk_no=excluded.chunk_no WHERE excluded.chunk_no>=document_continuations.chunk_no`});
const planWrite=write<[...Scope,string]>({name:'publication.savePlanKeys',sql:`INSERT INTO document_plan_keys(project_id,session_id,generation,plan_key)
  SELECT ?1,?2,?3,value FROM json_each(?4) WHERE true ON CONFLICT DO NOTHING`});
const retain=write<[...Scope,number]>({name:'publication.retainMetadataSource',sql:"UPDATE session_chunks SET metadata=1,kind='body' WHERE project_id=? AND session_id=? AND generation=? AND chunk_no=?"});
const activate=write<Scope>({name:'publication.activateOwnership',sql:'INSERT INTO document_metadata_ready(project_id,session_id,generation,tail_separated) VALUES(?,?,?,1) ON CONFLICT(project_id,session_id,generation) DO UPDATE SET tail_separated=1 WHERE tail_separated<>1'});

export class PublicationOwnership {
  constructor(private readonly db:RelationalStore,private readonly scope:Scope,private readonly admit:(calls:number)=>void) {}
  async ready():Promise<{ready:boolean;separated:boolean;failure:string|null}> { this.admit(1);const [rows]=await readSet(this.db,ready.bind(...this.scope));return {ready:rows.length!==0&&rows[0]!.failure===null,separated:rows[0]?.tail_separated===1,failure:rows[0]?.failure??null}; }
  async owners(keys:readonly string[]):Promise<Map<string,KeyOwner>> {
    const found=new Map<string,KeyOwner>();
    for(const page of jsonPages(keys)){this.admit(1);const [rows]=await readSet(this.db,owners.bind(...this.scope,JSON.stringify(page)));
      for(const row of rows)found.set(row.source_key,{thread:row.source_thread,record:row.source_record});}
    return found;
  }
  async state(transcript:string):Promise<number|null> {this.admit(1);const [rows]=await readSet(this.db,state.bind(...this.scope,transcript));return rows[0]?.chunk_no??null;}
  async plans(keys:readonly string[]):Promise<string[]> {
    const found:string[]=[];
    for(const page of jsonPages(keys)){this.admit(1);const [rows]=await readSet(this.db,plans.bind(...this.scope,JSON.stringify(page)));found.push(...rows.map(r=>r.plan_key));}
    return found;
  }
  bindings(shards:readonly MetadataShard[],initialize:boolean):Bound[] {
    const statements=[];
    for(const shard of shards){
      for(const page of jsonPages(shard.owners)){const value=JSON.stringify(page);statements.push(ownerWrite.bind(...this.scope,value),ownerGuard.bind(...this.scope,value));}
      for(const page of jsonPages(shard.states))statements.push(stateWrite.bind(...this.scope,shard.chunkNo,JSON.stringify(page)));
      for(const page of jsonPages(shard.plans))statements.push(planWrite.bind(...this.scope,JSON.stringify(page)));
    }
    if(initialize)statements.push(activate.bind(...this.scope));
    return statements;
  }
  retain(number:number):PreparedStatement {return prepareBound(this.db,retain.bind(...this.scope,number));}
  statements(shards:readonly MetadataShard[],initialize:boolean):PreparedStatement[] {
    return this.bindings(shards,initialize).map(bound=>prepareBound(this.db,bound));
  }
}

export function publicationOwnershipSchema():string[] {
  const scope=`project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,generation INTEGER NOT NULL`;
  return [
    'ALTER TABLE session_chunks ADD COLUMN metadata INTEGER NOT NULL DEFAULT 0',
    'CREATE INDEX IF NOT EXISTS idx_document_page_tail ON session_chunks(project_id,session_id,generation,chunk_no DESC) WHERE kind=\'page\' AND metadata=0',
    `CREATE TABLE IF NOT EXISTS document_owners(${scope},source_key TEXT NOT NULL,source_thread TEXT NOT NULL,source_record TEXT NOT NULL,PRIMARY KEY(project_id,session_id,generation,source_key)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS document_continuations(${scope},transcript_id TEXT NOT NULL,chunk_no INTEGER NOT NULL,PRIMARY KEY(project_id,session_id,generation,transcript_id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS document_plan_keys(${scope},plan_key TEXT NOT NULL,PRIMARY KEY(project_id,session_id,generation,plan_key)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS document_metadata_progress(${scope},chunk_no INTEGER NOT NULL,blob_key TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(project_id,session_id,generation,chunk_no)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS document_metadata_ready(${scope},tail_separated INTEGER NOT NULL DEFAULT 0,failure TEXT,failure_chunk INTEGER,phase_generation INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,session_id,generation)) WITHOUT ROWID`,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT 'publication_ownership','publicationMetadata',
      NOT EXISTS(SELECT 1 FROM session_chunks WHERE kind='page') ON CONFLICT DO NOTHING`,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT 'publication_ownership','publicationOwnershipReady',
      NOT EXISTS(SELECT 1 FROM session_documents) ON CONFLICT DO NOTHING`,
  ];
}


export const METADATA_PHASE_SOURCE = {table:'session_chunks',columns:['project_id','session_id','generation','chunk_no'],where:"(kind='page' OR metadata=1)",pageSize:1};
export const OWNERSHIP_READY_SOURCE = {table:'session_documents',columns:['project_id','session_id']};
export const OWNERSHIP_INPUTS_READY = assertion<[]>({name:'publication.metadataInitialized',sql:`SELECT CASE WHEN
  EXISTS(SELECT 1 FROM projection_catchup WHERE projection='publication_ownership' AND phase='publicationMetadata' AND done=1)
  THEN 1 ELSE json_extract('[]','$[publication_ownership_building]') END`});
export const OWNERSHIP_READY_RECONCILE = [write<[string]>({name:'publication.ownershipReadyPage',sql:`INSERT INTO document_metadata_ready(project_id,session_id,generation)
  SELECT d.project_id,d.session_id,d.generation FROM json_each(?1) j JOIN session_documents d
    ON (d.project_id,d.session_id)=(json_extract(j.value,'$[0]'),json_extract(j.value,'$[1]'))
  WHERE d.generation IS NOT NULL ON CONFLICT DO NOTHING`})];
