import { expect, test } from 'bun:test';
import { readDirectory, readPageChunk } from '@myco-server-worker/content/document-reader.js';
import { encodePageChunk, type DecodedChunk } from '@myco-server-worker/content/document.js';
import { prepareDerivedStream } from '@myco-server-worker/core/registered-content.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { catchUpPhase } from '@myco-server-worker/db/projections/catchup.js';
import { captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import { DocumentBatch } from '@myco-server-worker/ingest/document-batch.js';
import { measuredStore } from './helpers/read-budget.js';
import { memoryBlobStore, uuid } from './helpers/fixtures.js';
import { limits, MIN, one, reply, user } from './helpers/document-publication.js';

test('advancing one continuation preserves every owner and other continuation in a legacy metadata source', async () => {
  await withDocumentStores(async (db,target) => {
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    const ids=['tx_00000000000000000000000000000001','tx_00000000000000000000000000000002'];
    const first=ids.map((_,i)=>user('first-'+i,'prompt '+i)+reply('reply '+i));
    const env=await captureDocumentTranscript(db,blobs,'s',ids[0]!,first[0]!,at,0,'codex');
    await captureDocumentTranscript(db,blobs,'s',ids[1]!,first[1]!,at+1,0,'codex');
    await publishDocuments(env,at+20*MIN,limits());
    const directory=(await readDirectory(db,'project','s'))!;
    const legacy:DecodedChunk={pages:[],states:new Map(),owners:[]};
    for(const row of directory.chunks.values()){
      const chunk=await readPageChunk(env,row);
      legacy.pages.push(...chunk.pages);
      for(const [key,state] of chunk.states)legacy.states.set(key,state);
      legacy.owners!.push(...chunk.owners??[]);
    }
    for(let i=0;i<600;i++)legacy.owners!.push(['held-'+i,{thread:'held-thread',record:'held-record-'+i}]);
    const bytes=new Uint8Array(await encodePageChunk(legacy)),key=await sha256HexOf(bytes),source='legacy-metadata';
    const doc=(await one(db,"SELECT created_by_token_id token FROM sessions WHERE session_id='s'"))!;
    await prepareDerivedStream(env,{projectId:'project',sessionId:'s',tokenId:String(doc.token),sourceKind:'document',
      eventId:source,resourceId:source,envelopeHash:source},{size:bytes.length,digest:key,stream:()=>new Blob([bytes]).stream()},at,{sql:'1',params:[]});
    await db.batch([
      ...['session_chunks','document_owners','document_continuations','document_plan_keys','document_metadata_ready']
        .map(table=>db.prepare("DELETE FROM "+table+" WHERE project_id='project' AND session_id='s'")),
      db.prepare("INSERT INTO session_chunks(project_id,session_id,generation,chunk_no,blob_key,kind,encoding,bytes,source_id,state) VALUES('project','s',1,0,?,'page','gzip-ndjson',?,?,'live')").bind(key,bytes.length,source),
      db.prepare("UPDATE session_pages SET chunk_no=0 WHERE project_id='project' AND session_id='s'"),
      db.prepare("UPDATE session_documents SET next_chunk=1 WHERE project_id='project' AND session_id='s'"),
      db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='publication_ownership'"),
    ]);
    const prompts=(await db.prepare('SELECT prompt_id,preview FROM session_prompts ORDER BY prompt_id').all()).results;
    const pending=await db.prepare("SELECT d.*,s.created_by_token_id token_id FROM session_documents d JOIN sessions s USING(project_id,session_id) WHERE d.session_id='s'").first();
    await expect(new DocumentBatch(env,'project','s',pending as never).open()).rejects.toThrow('publication_ownership_building');
    for(let pass=0;;pass++){
      expect(pass,target).toBeLessThan(10);
      let calls=0;
      const changed=await catchUpPhase(db,'publicationMetadata',at,blobs,count=>{calls+=count;});
      expect(calls,target).toBeLessThanOrEqual(120);
      if(changed===0)break;
    }
    await catchUpPhase(db,'publicationOwnershipReady',at,blobs);
    for(const [i,id] of ids.entries()){
      await captureDocumentTranscript(db,blobs,'s',id,user('next-'+i,'next '+i)+reply('next reply '+i),at+30*MIN,first[i]!.length,'codex');
      for(let pass=0;;pass++){
        expect(pass,target).toBeLessThan(10);
        if(!(await publishDocuments(env,at+50*MIN,limits())).more)break;
      }
      expect(await one(db,"SELECT blob_key,metadata FROM session_chunks WHERE project_id='project' AND session_id='s' AND chunk_no=0"),target).toEqual({blob_key:key,metadata:1});
    }
    expect(await one(db,"SELECT prompts,replies,due_at FROM session_documents WHERE session_id='s'"),target).toEqual({prompts:4,replies:4,due_at:null});
    expect((await db.prepare('SELECT prompt_id,preview FROM session_prompts ORDER BY prompt_id').all()).results,target).toEqual(expect.arrayContaining(prompts));
    expect((await db.prepare('SELECT source_key,source_thread,source_record FROM document_owners ORDER BY source_key').all()).results,target)
      .toEqual(expect.arrayContaining(legacy.owners!.map(([source_key,owner])=>({source_key,source_thread:owner.thread,source_record:owner.record}))));
    expect((await db.prepare('SELECT transcript_id FROM transcripts ORDER BY transcript_id').all()).results,target).toEqual(ids.map(transcript_id=>({transcript_id})));
  });
});


const OWNERSHIP_CLAIM_READ_CEILING=50;
const OWNERSHIP_CLAIM_WRITE_CEILING=45;
test.each([1,100,1500])('a keyed ownership claim has fixed D1 cost with %s saved turns',async turns=>{
  await withDocumentStores(async(db,target)=>{
    if(target!=='D1')return;
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN,id='tx_0123456789abcdef0123456789abcdef';
    const body=Array.from({length:turns},(_,i)=>JSON.stringify({type:'user',uuid:uuid(i*3+1),promptId:uuid(i*3+2),message:{role:'user',content:'prompt '+i}})+'\n'
      +JSON.stringify({type:'assistant',uuid:uuid(i*3+3),message:{role:'assistant',content:'answer '+i}})+'\n').join('');
    const env=await captureDocumentTranscript(db,blobs,'s',id,body,at,0,'claude-code');
    for(let pass=0;;pass++){
      expect(pass).toBeLessThan(100);
      if(!(await publishDocuments(env,at+20*MIN,limits())).more)break;
    }
    const pages=(await db.prepare("SELECT chunk_no,blob_key FROM session_chunks WHERE kind='page' ORDER BY chunk_no").all()).results;
    const prompts=(await db.prepare('SELECT prompt_id,preview FROM session_prompts ORDER BY prompt_id').all()).results;
    const doc=await db.prepare("SELECT d.*,s.created_by_token_id token_id FROM session_documents d JOIN sessions s USING(project_id,session_id) WHERE d.session_id='s'").first();
    const meter=measuredStore(db as never);
    const batch=new DocumentBatch({...env,db:meter.db},'project','s',doc as never);
    await batch.open();
    await batch.writer.readOwners(['new-key']);
    batch.writer.owners.set('new-key',{thread:'thread',record:'record'});
    await batch.commit(true,'live',at+30*MIN,()=>({sql:'1',params:[]}),()=>{
      const set=batch.documentSet(at+30*MIN);
      return {before:[],after:[meter.db.prepare("UPDATE session_documents SET "+set.sql+" WHERE project_id='project' AND session_id='s'").bind(...set.params)]};
    });
    expect(meter.reads()).toBeLessThanOrEqual(OWNERSHIP_CLAIM_READ_CEILING);
    expect(meter.writes()).toBeLessThanOrEqual(OWNERSHIP_CLAIM_WRITE_CEILING);
    expect(await one(db,"SELECT source_thread,source_record FROM document_owners WHERE project_id='project' AND session_id='s' AND generation=1 AND source_key='new-key'")).toEqual({source_thread:'thread',source_record:'record'});
    expect((await db.prepare("SELECT chunk_no,blob_key FROM session_chunks WHERE kind='page' ORDER BY chunk_no").all()).results).toEqual(pages);
    expect((await db.prepare('SELECT prompt_id,preview FROM session_prompts ORDER BY prompt_id').all()).results).toEqual(prompts);
    expect(await one(db,"SELECT prompts FROM session_documents WHERE session_id='s'")).toEqual({prompts:turns});
  });
}, 120_000);
