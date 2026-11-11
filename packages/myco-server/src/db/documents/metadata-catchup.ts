import type { BlobStore, RelationalStore } from '../../core/adapters.js';
import { readPageChunk, type ChunkRow } from '../../content/document-reader.js';
import { registeredObjectKeySql } from '../storage/registered-object-key.js';
import { assertion, commit, read, readSet, refused, write, type Bound } from '../index.js';
import { DOCUMENT_OWNERSHIP_CONFLICT, METADATA_PHASE_SOURCE, OWNERSHIP_INPUTS_READY, OWNERSHIP_READY_RECONCILE, OWNERSHIP_READY_SOURCE, PublicationOwnership } from './ownership.js';
import { documentPassFailure } from './failure-head.js';
import type { DecodedChunk } from '../../content/document.js';
import type { CatchupFamily, PageContext, PagePlan } from '../projections/family.js';

const metadataCursorHeld=assertion<[string,number]>({name:'publication.metadataCursorHeld',sql:`SELECT CASE WHEN
  EXISTS(SELECT 1 FROM projection_catchup WHERE projection='publication_ownership' AND phase='publicationMetadata' AND after_key=?1 AND generation=?2 AND done=0)
  THEN 1 ELSE json_extract('[]','$[publication_metadata_changed]') END`});
const source=read<[string,string,number,number],ChunkRow>({name:'publication.metadataSource',sql:`SELECT c.chunk_no,c.blob_key,c.kind,c.bytes,c.source_id,c.metadata,
  ${registeredObjectKeySql('c.project_id','c.blob_key')} object_key FROM session_chunks c
  WHERE (c.project_id,c.session_id,c.generation,c.chunk_no)=(?1,?2,?3,?4) AND (c.kind='page' OR c.metadata=1)`});
const unchanged=assertion<[string,string,number,number,string]>({name:'publication.metadataUnchanged',sql:`SELECT CASE WHEN
  EXISTS(SELECT 1 FROM session_chunks WHERE (project_id,session_id,generation,chunk_no,blob_key)=(?1,?2,?3,?4,?5))
  AND NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=?1 AND session_id=?2)
  THEN 1 ELSE json_extract('[]','$[publication_metadata_changed]') END`});
const tombstone=read<[string,string],{present:number}>({name:'publication.metadataTombstone',sql:'SELECT 1 present FROM session_tombstones WHERE project_id=? AND session_id=?'});

const progress=read<[string,string,number,number,string],{position:number}>({name:'publication.metadataProgress',sql:
  'SELECT position FROM document_metadata_progress WHERE project_id=? AND session_id=? AND generation=? AND chunk_no=? AND blob_key=?'});
const positionHeld=assertion<[string,string,number,number,string,number]>({name:'publication.metadataPositionHeld',sql:`SELECT CASE WHEN
  COALESCE((SELECT position FROM document_metadata_progress WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND chunk_no=?4 AND blob_key=?5),0)=?6
  THEN 1 ELSE json_extract('[]','$[publication_metadata_changed]') END`});
const saveProgress=write<[string,string,number,number,string,number]>({name:'publication.metadataAdvance',sql:`INSERT INTO document_metadata_progress
  (project_id,session_id,generation,chunk_no,blob_key,position) VALUES(?,?,?,?,?,?)
  ON CONFLICT(project_id,session_id,generation,chunk_no) DO UPDATE SET blob_key=excluded.blob_key,position=excluded.position`});
const clearProgress=write<[string,string,number,number]>({name:'publication.metadataComplete',sql:
  'DELETE FROM document_metadata_progress WHERE project_id=? AND session_id=? AND generation=? AND chunk_no=?'});
const failed=read<[string,string,number,number],{failure:string}>({name:'publication.metadataFailedSession',sql:
  'SELECT failure FROM document_metadata_ready WHERE project_id=? AND session_id=? AND generation=? AND phase_generation=? AND failure IS NOT NULL'});
const unavailable=write<[string,string,number,number,number,string]>({name:'publication.metadataUnavailable',sql:`INSERT INTO document_metadata_ready
  (project_id,session_id,generation,failure_chunk,phase_generation,failure) SELECT ?1,?2,?3,?4,?5,?6
  WHERE NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=?1 AND session_id=?2)
  ON CONFLICT(project_id,session_id,generation) DO UPDATE SET
    failure=CASE WHEN failure IS NOT NULL AND phase_generation=excluded.phase_generation AND failure_chunk<excluded.failure_chunk THEN failure ELSE excluded.failure END,
    failure_chunk=CASE WHEN failure IS NOT NULL AND phase_generation=excluded.phase_generation THEN MIN(failure_chunk,excluded.failure_chunk) ELSE excluded.failure_chunk END,
    phase_generation=excluded.phase_generation`});
const scheduleFailed=write<[string,string,number,number]>({name:'publication.metadataFailedDue',sql:"UPDATE session_documents SET due_at=?4 WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND state='live' AND due_at IS NULL"});
const finishSession=write<[string,string,number,number,number]>({name:'publication.metadataSessionReady',sql:`INSERT INTO document_metadata_ready(project_id,session_id,generation,phase_generation)
  SELECT ?1,?2,?3,?5 WHERE NOT EXISTS(SELECT 1 FROM session_chunks WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND chunk_no>?4 AND (kind='page' OR metadata=1))
  ON CONFLICT(project_id,session_id,generation) DO UPDATE SET failure=NULL,failure_chunk=NULL,phase_generation=excluded.phase_generation
    WHERE document_metadata_ready.failure IS NULL OR document_metadata_ready.phase_generation<>excluded.phase_generation`});
const armSession=write<[string,string,number,number]>({name:'publication.metadataArmSession',sql:`UPDATE session_documents SET due_at=0
  WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND state='live'
    AND EXISTS(SELECT 1 FROM document_metadata_ready WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND failure IS NULL)
    AND NOT EXISTS(SELECT 1 FROM session_chunks WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND chunk_no>?4 AND (kind='page' OR metadata=1))
    AND NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=?1 AND session_id=?2)`});
const METADATA_KEYS_PER_PAGE=250;
const METADATA_FAILURE_LOOKBACK_MS=7*24*60*60*1000;
type MetadataFailure = 'document_object_missing' | 'document_metadata_unreadable' | 'document_ownership_conflict';

/** Records each session's earliest unresolved chunk among `keys`, and makes a settled session due so its failure is retried and stays visible. */
function metadataFailure(keys:readonly (readonly unknown[])[],phaseGeneration:number,now:number,reason:MetadataFailure):Bound[] {
  const earliest=new Map<string,readonly unknown[]>();
  for(const key of keys){const scope=JSON.stringify(key.slice(0,3));if(!earliest.has(scope))earliest.set(scope,key);}
  return [...earliest.values()].flatMap(key=>{
    const [project,session,generation,number]=key as [string,string,number,number];
    return [unavailable.bind(project,session,generation,number,phaseGeneration,reason),
      scheduleFailed.bind(project,session,generation,now),
      documentPassFailure({projectId:project,sessionId:session,failure:'metadata_unavailable'},now,now-METADATA_FAILURE_LOOKBACK_MS)];
  });
}

type ChunkWork={failed:boolean;statements:Bound[];guards:Bound[];complete:boolean};

/** One bounded page of one metadata chunk, or null when the chunk is gone or its session already failed in `skipFailedIn`. */
async function metadataChunk(db:RelationalStore,blobs:BlobStore,key:readonly unknown[],charge:(calls:number)=>void,phaseGeneration:number,skipFailedIn:number,now:number):Promise<ChunkWork|null> {
  const [project,session,generation,number]=key as [string,string,number,number];
  charge(3);
  const [rows,deleted,failures]=await readSet(db,source.bind(project,session,generation,number),tombstone.bind(project,session),failed.bind(project,session,generation,skipFailedIn));
  const row=rows[0];if(!row||deleted.length>0||failures.length>0)return null;
  const guards=[unchanged.bind(project,session,generation,number,row.blob_key)];
  charge(2);
  const [held]=await readSet(db,progress.bind(project,session,generation,number,row.blob_key));
  const position=held[0]?.position??0;
  const positionGuard=positionHeld.bind(project,session,generation,number,row.blob_key,position);
  guards.push(positionGuard);
  let chunk:DecodedChunk;
  try { chunk=await readPageChunk({blobs},row); }
  catch(error) {
    const reason=error instanceof Error&&error.message==='document_object_missing'?'document_object_missing':'document_metadata_unreadable';
    return {failed:true,complete:false,guards,statements:[unchanged.bind(project,session,generation,number,row.blob_key),positionGuard,...metadataFailure([key],phaseGeneration,now,reason)]};
  }
  const entries=[
    ...(chunk.owners??[]).map(owner=>({kind:'owner' as const,owner})),
    ...[...chunk.states.keys()].map(state=>({kind:'state' as const,state})),
    ...(chunk.plans??[]).map(plan=>({kind:'plan' as const,plan})),
  ];
  const page=entries.slice(position,position+METADATA_KEYS_PER_PAGE);
  const next=position+page.length,complete=next>=entries.length;
  return {failed:false,complete,guards,statements:[unchanged.bind(project,session,generation,number,row.blob_key),positionGuard,
    ...new PublicationOwnership(db,[project,session,generation],()=>{}).bindings([{
      chunkNo:number,owners:page.flatMap(e=>e.kind==='owner'?[e.owner]:[]),
      states:page.flatMap(e=>e.kind==='state'?[e.state]:[]),plans:page.flatMap(e=>e.kind==='plan'?[e.plan]:[]),
    }],false),
    complete?clearProgress.bind(project,session,generation,number):saveProgress.bind(project,session,generation,number,row.blob_key,next)]};
}

/** A bounded metadata page and its source position settle with the shared projection cursor. */
async function metadataPage(db:RelationalStore,blobs:BlobStore,keys:readonly (readonly unknown[])[],charge:(calls:number)=>void,phaseGeneration=0,now=Date.now()):Promise<{statements:Bound[];guards:Bound[];complete:boolean}> {
  const statements:Bound[]=[];
  const guards:Bound[]=[];
  for(const key of keys){
    const [project,session,generation,number]=key as [string,string,number,number];
    const work=await metadataChunk(db,blobs,key,charge,phaseGeneration,phaseGeneration,now);
    if(work===null)continue;
    guards.push(...work.guards);
    statements.push(...work.statements);
    if(work.failed)continue;
    if(!work.complete)return {statements,guards,complete:false};
    statements.push(finishSession.bind(project,session,generation,number,phaseGeneration),armSession.bind(project,session,generation,number));
  }
  return {statements,guards,complete:true};
}

const failedAt=read<[string,string],{generation:number;failure_chunk:number;phase_generation:number;restart:number|null}>({name:'publication.metadataFailedAt',sql:`SELECT m.generation,m.failure_chunk,m.phase_generation,
    (SELECT generation FROM projection_catchup WHERE projection='publication_ownership' AND phase='publicationMetadata') restart
  FROM document_metadata_ready m CROSS JOIN session_documents d ON (d.project_id,d.session_id,d.generation)=(m.project_id,m.session_id,m.generation)
  WHERE m.project_id=? AND m.session_id=? AND m.failure IS NOT NULL AND m.failure_chunk IS NOT NULL`});
const chunksFrom=read<[string,string,number,number,number],{chunk_no:number}>({name:'publication.metadataChunksFrom',sql:`SELECT chunk_no FROM session_chunks
  WHERE project_id=? AND session_id=? AND generation=? AND chunk_no>=? AND (kind='page' OR metadata=1) ORDER BY chunk_no LIMIT ?`});
const repairHeld=assertion<[string,string,number,number,number]>({name:'publication.metadataRepairHeld',sql:`SELECT CASE WHEN
  EXISTS(SELECT 1 FROM document_metadata_ready WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND failure IS NOT NULL AND failure_chunk=?4 AND phase_generation=?5)
  AND EXISTS(SELECT 1 FROM projection_catchup WHERE projection='publication_ownership' AND phase='publicationMetadata' AND generation=?5)
  THEN 1 ELSE json_extract('[]','$[publication_metadata_changed]') END`});
const resumeFrom=write<[string,string,number,number]>({name:'publication.metadataResumeFrom',sql:'UPDATE document_metadata_ready SET failure_chunk=?4 WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND failure IS NOT NULL'});
const repaired=write<[string,string,number]>({name:'publication.metadataRepaired',sql:'UPDATE document_metadata_ready SET failure=NULL,failure_chunk=NULL WHERE project_id=?1 AND session_id=?2 AND generation=?3'});
const dueNow=write<[string,string,number]>({name:'publication.metadataRepairDue',sql:"UPDATE session_documents SET due_at=0 WHERE project_id=? AND session_id=? AND generation=? AND state='live'"});
const METADATA_REPAIR_CHUNKS=8;

/**
 * Re-reads a session's unreadable metadata when the session comes due, so a transient read or an object put back recovers
 * without a restore. The pass walks forward from the earliest unresolved chunk, each chunk its own commit fenced by that
 * position and the projection's restart generation, stops at the first chunk still unresolved, and clears the failure only
 * on reaching the end. A failure belonging to an earlier restart is left to the catch-up now re-reading the session.
 * True when the pass made progress; a chunk still unreadable renews the failure signal and answers false.
 */
export async function repairPublicationMetadata(db:RelationalStore,blobs:BlobStore,project:string,session:string,now:number):Promise<boolean> {
  const [rows]=await readSet(db,failedAt.bind(project,session));
  const held=rows[0];
  if(held===undefined||held.restart!==held.phase_generation)return false;
  const {generation,phase_generation:phase}=held;
  const [chunks]=await readSet(db,chunksFrom.bind(project,session,generation,held.failure_chunk,METADATA_REPAIR_CHUNKS+1));
  if(chunks.length===0){await commit(db,repairHeld.bind(project,session,generation,held.failure_chunk,phase),repaired.bind(project,session,generation));return true;}
  let at=held.failure_chunk;
  for(let i=0;i<Math.min(chunks.length,METADATA_REPAIR_CHUNKS);i++){
    const number=chunks[i]!.chunk_no;
    const key=[project,session,generation,number] as const;
    const hold=repairHeld.bind(project,session,generation,at,phase);
    const work=await metadataChunk(db,blobs,key,()=>{},phase,-1,now);
    if(work===null)return false;
    if(work.failed){await commit(db,hold,...work.statements);return false;}
    const next=chunks[i+1]?.chunk_no;
    const settle=!work.complete?[dueNow.bind(project,session,generation)]
      :next===undefined?[repaired.bind(project,session,generation),armSession.bind(project,session,generation,number)]
      :[resumeFrom.bind(project,session,generation,next)];
    try { await commit(db,hold,...work.statements,...settle); }
    catch(error) {
      if(!refused(error,DOCUMENT_OWNERSHIP_CONFLICT))throw error;
      await commit(db,hold,...metadataFailure([key],phase,now,DOCUMENT_OWNERSHIP_CONFLICT));
      return false;
    }
    if(!work.complete||next===undefined)return true;
    at=next;
  }
  await commit(db,repairHeld.bind(project,session,generation,at,phase),dueNow.bind(project,session,generation));
  return true;
}

const metadataCatchupPage=async({db,blobs,keys,charge,generation,now}:PageContext):Promise<PagePlan>=>{
  if(keys.length>0&&blobs===undefined)throw new Error('publication_metadata_blob_store_required');
  const metadata=await metadataPage(db,blobs!,keys,charge,generation,now);
  return {statements:metadata.statements,complete:metadata.complete,
    recover:error=>refused(error,DOCUMENT_OWNERSHIP_CONFLICT)?[...metadata.guards,...metadataFailure(keys,generation,now,DOCUMENT_OWNERSHIP_CONFLICT)]:undefined};
};

/** Metadata pages read their chunks from the blob store; the readiness pass waits for every page to have been seen. */
export const PUBLICATION_OWNERSHIP_CATCHUP={
  projection:'publication_ownership',
  phases:{
    publicationMetadata:{source:METADATA_PHASE_SOURCE,reconcile:[],guards:held=>[metadataCursorHeld.bind(held.after_key,held.generation)],page:metadataCatchupPage},
    publicationOwnershipReady:{source:OWNERSHIP_READY_SOURCE,reconcile:OWNERSHIP_READY_RECONCILE,frontier:()=>[OWNERSHIP_INPUTS_READY.bind()]},
  },
} as const satisfies CatchupFamily;
