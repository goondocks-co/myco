import { expect, test } from 'bun:test';
import { catchUpPhase, catchUpProjections, resetProjectionCatchup } from '@myco-server-worker/db/projections/catchup.js';
import { sharesSessionScheme, restoreSchemeDecisions } from '@myco-server-worker/db/documents/pins.js';
import { restoreRecordSchemeDecisions } from '@myco-server-worker/db/documents/restore-pins.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { DocumentBatch } from '@myco-server-worker/ingest/document-batch.js';
import { applyDocumentRestore } from '@myco-server-worker/ingest/document-restore.js';
import { handleRestoreBackup, handleRestoreUpload } from '@myco-server-worker/api/backups.js';
import { BACKUP_FORMAT, deploymentId } from '@myco-server-worker/core/backup.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { statusMetadata } from '@myco-server-worker/db/documents/failure-head.js';
import { repairPublicationMetadata } from '@myco-server-worker/db/documents/metadata-catchup.js';
import { readDirectory, readPageChunk } from '@myco-server-worker/content/document-reader.js';
import { encodePageChunk } from '@myco-server-worker/content/document.js';
import { withDocumentStores, captureDocumentTranscript } from './helpers/document-stores.js';
import { memoryBlobStore, envelope, uuid } from './helpers/fixtures.js';
import { limits, MIN, one, user, reply, tx } from './helpers/document-publication.js';

const id='tx_0123456789abcdef0123456789abcdef';
const resetPins=async(db:Parameters<typeof catchUpPhase>[0])=>{
  await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='publication_pins'").run();
};
const finishPins=async(db:Parameters<typeof catchUpPhase>[0])=>{
  for(const phase of ['publicationPinGroups','publicationPinsReady'] as const) while(await catchUpPhase(db,phase)){}
};

test('capture during pin initialization waits without a terminal stop and publishes after pin admission',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    await resetPins(db);
    const env=await captureDocumentTranscript(db,blobs,'new',id,user('turn','retained')+reply('answer'),at,0,'codex');
    const source=await db.prepare('SELECT transcript_id,size FROM transcripts').first();
    await publishDocuments(env,at+20*MIN,limits());
    expect(await one(db,"SELECT COUNT(*) n FROM transcript_publication WHERE state='failed'"),target).toEqual({n:0});
    await finishPins(db);
    await publishDocuments(env,at+21*MIN,limits());
    expect(await one(db,"SELECT prompts,replies FROM session_documents WHERE session_id='new'"),target).toEqual({prompts:1,replies:1});
    expect(await db.prepare('SELECT transcript_id,size FROM transcripts').first(),target).toEqual(source);
  });
});

test('pin admission resumes the stored parse scheme-conflict diagnostic',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    await resetPins(db);
    const env=await captureDocumentTranscript(db,blobs,'new',id,user('turn','retained'),at,0,'codex');
    await db.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,session_id,generation,published_offset,state,failure,diagnostic,record_scheme,parser_version,updated_at)
      VALUES('project',?,'new',1,0,'failed','parse','{"branch":"scheme_conflict"}','source-record-v1',0,1)`).bind(id).run();
    await finishPins(db);
    await publishDocuments(env,at+20*MIN,limits());
    expect(await one(db,"SELECT prompts FROM session_documents WHERE session_id='new'"),target).toEqual({prompts:1});
  });
});

test('prompt scheme reads and context delivery remain available while pin groups build',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    const env=await captureDocumentTranscript(db,blobs,'capture',id,user('turn','retained'),at,0,'codex');
    await resetPins(db);
    expect(await sharesSessionScheme(db,'project','capture','codex-turn-v1'),target).toBe(true);
    const token=String((await one(db,'SELECT token_id FROM transcripts'))!.token_id);
    await db.prepare(`INSERT INTO spore_injections(project_id,session_id,id,scope_reason,ask_protocol,asked_at,prompt_hash,spore_ids,created_at)
      VALUES('project','capture',?,'scheme','v1',1,'hash','[]',1)`).bind(uuid(92002)).run();
    const result=await ingestEvent(db,{projectId:'project',machineId:'machine',tokenId:token,bodyBytes:1,now:at},
      envelope({eventId:uuid(92001),sessionId:'capture',kind:'context.delivered',createdAt:at,
        payload:{receiptId:uuid(92002),renderedIn:uuid(92003),renderedScheme:'codex-turn-v1'}}),env);
    expect(result.persisted,target).toBe(true);
    expect(await one(db,"SELECT COUNT(*) n FROM events WHERE kind='context.delivered'"),target).toEqual({n:1});
    expect(await one(db,'SELECT delivered_prompt_id,delivered_scope_reason FROM spore_injections'),target)
      .toEqual({delivered_prompt_id:uuid(92003),delivered_scope_reason:null});
  });
});

test.each(['missing','decode','ownership'] as const)('%s metadata isolates one session while catch-up and unrelated publication finish',async fault=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    const env=await captureDocumentTranscript(db,blobs,'bad',id,user('bad','retained'),at,0,'codex');
    await captureDocumentTranscript(db,blobs,'good',id.slice(0,-1)+'0',user('good','retained'),at,0,'codex');
    await publishDocuments(env,at+20*MIN,limits());
    const directory=(await readDirectory(db,'project','bad'))!;
    const broken=[...directory.chunks.values()][0]!;
    if(fault==='missing')blobs.objects.delete(broken.object_key!);
    else {
      const source=blobs.objects.get(broken.object_key!)!;
      const chunk=await readPageChunk(env,broken);
      const bytes=fault==='decode'?new Uint8Array([1,2,3]):new Uint8Array(await encodePageChunk({...chunk,owners:[['held',{thread:'original',record:'record'}]]}));
      blobs.objects.set(broken.object_key!,{...source,bytes,size:bytes.length});
      if(fault==='ownership')await db.prepare("INSERT INTO document_owners VALUES('project','bad',1,'held','different','record')").run();
    }
    await db.prepare('DELETE FROM document_metadata_ready').run();
    await resetProjectionCatchup(db);
    for(let pass=0;pass<30;pass++)if(!(await catchUpProjections(db,{blobs,budget:{calls:120,wallMs:60000}})).more)break;
    expect(await one(db,"SELECT COUNT(*) n FROM projection_catchup WHERE done=0"),target).toEqual({n:0});
    expect((await statusMetadata(db)).documentPublishFailure,target).toContain('metadata_unavailable');
    await captureDocumentTranscript(db,blobs,'good',id.slice(0,-1)+'0',user('later','new bytes'),at+30*MIN,user('good','retained').length,'codex');
    await publishDocuments(env,at+40*MIN,limits());
    expect(await one(db,"SELECT prompts FROM session_documents WHERE session_id='good'"),target).toEqual({prompts:2});
    expect(await one(db,"SELECT COUNT(*) n FROM transcripts"),target).toEqual({n:2});
  });
});

test.each(['restart','advance'] as const)('%s metadata cannot be failed by an older in-flight blob read',async action=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    const env=await captureDocumentTranscript(db,blobs,'restarted',id,user('turn','retained'),at,0,'codex');
    await publishDocuments(env,at+20*MIN,limits());
    if(action==='advance'){
      const row=[...(await readDirectory(db,'project','restarted'))!.chunks.values()].find(row=>row.kind==='page')!;
      const chunk=await readPageChunk(env,row),source=blobs.objects.get(row.object_key!)!;
      const owners=Array.from({length:300},(_,i)=>[`held-${i}`,{thread:'thread',record:`record-${i}`}] as [string,{thread:string;record:string}]);
      const bytes=new Uint8Array(await encodePageChunk({...chunk,owners}));
      blobs.objects.set(row.object_key!,{...source,bytes,size:bytes.length});
    }
    await db.prepare('DELETE FROM document_metadata_ready').run();
    await resetProjectionCatchup(db);
    let entered!:()=>void,release!:()=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;});
    const held=new Promise<void>(resolve=>{release=resolve;});
    const old=catchUpPhase(db,'publicationMetadata',at,{...blobs,get:async()=>{entered();await held;return null;}});
    await reading;
    if(action==='restart'){
      await resetProjectionCatchup(db);
      while(await catchUpPhase(db,'publicationMetadata',at,blobs)){}
    }else await catchUpPhase(db,'publicationMetadata',at,blobs);
    release();
    await expect(old).rejects.toThrow('publication_metadata_changed');
    while(await catchUpPhase(db,'publicationMetadata',at,blobs)){}
    expect(await one(db,"SELECT failure FROM document_metadata_ready WHERE session_id='restarted'"),target).toEqual({failure:null});
    await captureDocumentTranscript(db,blobs,'restarted',id,user('later','new bytes'),at+30*MIN,user('turn','retained').length,'codex');
    await publishDocuments(env,at+40*MIN,limits());
    expect(await one(db,"SELECT prompts FROM session_documents WHERE session_id='restarted'"),target).toEqual({prompts:2});
  });
});

test('one session becomes publishable before later sessions finish metadata initialization',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    const first=user('a','retained');
    const env=await captureDocumentTranscript(db,blobs,'a',id,first,at,0,'codex');
    await captureDocumentTranscript(db,blobs,'z',id.slice(0,-1)+'0',user('z','retained'),at,0,'codex');
    await publishDocuments(env,at+20*MIN,limits());
    const chunks=[...(await readDirectory(db,'project','a'))!.chunks.values()];
    await db.prepare('DELETE FROM document_metadata_ready').run();
    await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='publication_ownership'").run();
    for(const _ of chunks)await catchUpPhase(db,'publicationMetadata',at,blobs);
    expect(await one(db,"SELECT done FROM projection_catchup WHERE phase='publicationMetadata'"),target).toEqual({done:0});
    await captureDocumentTranscript(db,blobs,'a',id,user('next','new bytes'),at+30*MIN,first.length,'codex');
    await publishDocuments(env,at+40*MIN,limits());
    expect(await one(db,"SELECT prompts FROM session_documents WHERE session_id='a'"),target).toEqual({prompts:2});
  });
});

test('restore bounds pin initialization and returns a named retryable result before applying source rows',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    await captureDocumentTranscript(db,blobs,'restore',id,user('turn','retained'),at,0,'codex');
    await db.prepare(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,first_received_at,last_received_at,token_id)
      SELECT 'project',value,'restore','machine','codex',0,1,1,'test' FROM json_each(?)`)
      .bind(JSON.stringify(Array.from({length:201},(_,i)=>'pending-'+i.toString().padStart(3,'0')))).run();
    await resetPins(db);
    const before=(await db.prepare('SELECT * FROM transcripts ORDER BY transcript_id').all()).results;
    const carried=before.filter(row=>row.transcript_id===id);
    await expect(restoreRecordSchemeDecisions(db,carried)).rejects.toMatchObject({code:'publication_restore_building',retryable:true});
    expect((await db.prepare('SELECT * FROM transcripts ORDER BY transcript_id').all()).results,target).toEqual(before);
    expect(await one(db,"SELECT done,after_key FROM projection_catchup WHERE phase='publicationPinGroups'"),target)
      .toEqual({done:0,after_key:'["project","pending-099"]'});
    await expect(restoreSchemeDecisions(db,carried)).rejects.toMatchObject({code:'publication_restore_building',retryable:true});
  });
});

test('a continuation locator whose chunk no longer holds the state reads as no continuation',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    const env=await captureDocumentTranscript(db,blobs,'stale',id,user('turn','retained'),at,0,'codex');
    await publishDocuments(env,at+20*MIN,limits());
    await db.prepare("UPDATE document_continuations SET chunk_no=(SELECT chunk_no FROM session_chunks WHERE kind='page' LIMIT 1)").run();
    const doc=await db.prepare("SELECT d.*,s.created_by_token_id token_id FROM session_documents d JOIN sessions s USING(project_id,session_id) WHERE d.session_id='stale'").first();
    const batch=new DocumentBatch(env,'project','stale',doc as never);
    await batch.open();
    await batch.writer.readState(id);
    expect(batch.writer.states.get(id),target).toBeUndefined();
    expect(await one(db,"SELECT prompts FROM session_documents WHERE session_id='stale'"),target).toEqual({prompts:1});
    await captureDocumentTranscript(db,blobs,'stale',id,user('later','new bytes'),at+30*MIN,user('turn','retained').length,'codex');
    for(let pass=0;pass<20;pass++)if(!(await publishDocuments(env,at+40*MIN,limits())).more)break;
    expect(await one(db,"SELECT prompts FROM session_documents WHERE session_id='stale'"),target).toEqual({prompts:2});
  });
});

test('document restore reports ownership initialization as retryable and retains the existing document',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    const env=await captureDocumentTranscript(db,blobs,'restore',id,user('turn','retained'),at,0,'codex');
    await publishDocuments(env,at+20*MIN,limits());
    const before=(await db.prepare('SELECT * FROM session_chunks ORDER BY chunk_no').all()).results;
    await db.prepare('DELETE FROM document_metadata_ready').run();
    await expect(applyDocumentRestore(env,{convert:[],merge:[{projectId:'project',sessionId:'restore',snapshot:{records:[],states:new Map(),owners:null,plans:new Set(),frontiers:[],chunks:[]}}]},at+30*MIN))
      .rejects.toMatchObject({code:'publication_restore_building',retryable:true});
    expect((await db.prepare('SELECT * FROM session_chunks ORDER BY chunk_no').all()).results,target).toEqual(before);
  });
});

test('a failed projection reports its phase while independent projections continue',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    const env=await captureDocumentTranscript(db,blobs,'healthy',id,user('turn','retained'),at,0,'codex');
    await publishDocuments(env,at+20*MIN,limits());
    await db.prepare('DELETE FROM document_transcript_pins').run();
    await db.prepare('DELETE FROM document_metadata_ready').run();
    await resetProjectionCatchup(db);
    await db.prepare("CREATE TRIGGER refuse_pin_fixture BEFORE INSERT ON document_transcript_pins BEGIN SELECT RAISE(ABORT,'fixture_store_failure'); END").run();
    const result=await catchUpProjections(db,{blobs,budget:{calls:1000,wallMs:60000}});
    expect(result,target).toMatchObject({more:false,failures:[{projection:'publication_pins',phase:'publicationPinGroups'}]});
    expect(await one(db,"SELECT done FROM projection_catchup WHERE phase='publicationOwnershipReady'"),target).toEqual({done:1});
    expect(await one(db,"SELECT prompts FROM session_documents WHERE session_id='healthy'"),target).toEqual({prompts:1});
  });
});

const metadataWith=async(db:Parameters<typeof catchUpPhase>[0],blobs:ReturnType<typeof memoryBlobStore>,get:(key:string)=>unknown)=>{
  await db.prepare('DELETE FROM document_owners').run();
  await db.prepare('DELETE FROM document_metadata_ready').run();
  await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL,generation=generation+1 WHERE projection='publication_ownership'").run();
  const faulty=new Proxy(blobs,{get(store,key){return key==='get'?get:Reflect.get(store,key);}});
  await catchUpProjections(db,{blobs:faulty,budget:{calls:1000,wallMs:60000}});
};

for(const [name,fault,failure] of [
  ['one thrown read',()=>{throw new Error('object_store_unavailable');},'document_metadata_unreadable'],
  ['an object that comes back',async()=>null,'document_object_missing'],
] as const) test(`a session whose metadata failed on ${name} recovers when its session comes due, with nothing lost`,async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-600*MIN;
    const first=user('turn','retained')+reply('answer');
    const env=await captureDocumentTranscript(db,blobs,'s1',id,first,at,0,'codex');
    await publishDocuments(env,at+20*MIN,limits());
    await metadataWith(db,blobs,fault);
    expect(await one(db,"SELECT failure FROM document_metadata_ready WHERE session_id='s1'"),target).toEqual({failure});
    await db.prepare("UPDATE session_documents SET due_at=0 WHERE session_id='s1'").run();
    await publishDocuments(env,at+60*MIN,limits());
    expect(await one(db,"SELECT failure,failure_chunk FROM document_metadata_ready WHERE session_id='s1'"),target).toEqual({failure:null,failure_chunk:null});
    await db.prepare("UPDATE session_documents SET due_at=0 WHERE session_id='s1'").run();
    await publishDocuments(env,at+61*MIN,limits());
    expect(await one(db,"SELECT prompts,replies FROM session_documents WHERE session_id='s1'"),target).toEqual({prompts:1,replies:1});
  });
});

test('a chunk still unreadable when its session comes due stays failed and renews the failure signal',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-600*MIN;
    const env=await captureDocumentTranscript(db,blobs,'s1',id,user('turn','retained'),at,0,'codex');
    await publishDocuments(env,at+20*MIN,limits());
    await metadataWith(db,blobs,async()=>null);
    const lost=new Proxy(env,{get(store,key){return key==='blobs'?new Proxy(blobs,{get(b,k){return k==='get'?async()=>null:Reflect.get(b,k);}}):Reflect.get(store,key);}});
    await db.prepare("UPDATE session_documents SET due_at=0 WHERE session_id='s1'").run();
    const later=at+300*MIN;
    await publishDocuments(lost,later,limits());
    expect(await one(db,"SELECT failure FROM document_metadata_ready WHERE session_id='s1'"),target).toEqual({failure:'document_object_missing'});
    expect(JSON.parse((await statusMetadata(db)).documentPublishFailure!),target).toMatchObject({last_failed_at:later});
  });
});

test('a transcript registered while pins build shares its declared scheme, and is not read as a mismatch',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    await resetPins(db);
    await captureDocumentTranscript(db,blobs,'new',id,user('turn','retained'),at,0,'codex');
    expect(await one(db,"SELECT prompt_identity_scheme FROM transcripts WHERE session_id='new'"),target).toEqual({prompt_identity_scheme:null});
    expect(await sharesSessionScheme(db,'project','new','codex-turn-v1'),target).toBe(true);
    expect(await sharesSessionScheme(db,'project','new','hook-mint-v1'),target).toBe(false);
  });
});

const twoChunks=async(db:Parameters<typeof catchUpPhase>[0],at:number)=>{
  const blobs=memoryBlobStore();
  const env=await captureDocumentTranscript(db,blobs,'s',tx,user('turn','retained')+reply('answer'),at,0,'codex');
  await publishDocuments(env,at+20*MIN,limits());
  const chunks=[...(await readDirectory(db,'project','s'))!.chunks.values()].filter(c=>c.kind==='page'||c.metadata===1).sort((a,b)=>a.chunk_no-b.chunk_no);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  return {blobs,env,chunks};
};
const failure=(db:Parameters<typeof catchUpPhase>[0])=>one(db,"SELECT failure,failure_chunk FROM document_metadata_ready WHERE session_id='s'");
const without=(blobs:ReturnType<typeof memoryBlobStore>,...keys:string[])=>new Proxy(blobs,{get(store,key){return key==='get'?async(k:string)=>keys.includes(k)?null:store.get(k):Reflect.get(store,key);}});

test('an ownership conflict in an early chunk holds the failure there, even when every later chunk is healthy',async()=>{
  await withDocumentStores(async(db,target)=>{
    const at=Date.now()-600*MIN,{blobs,chunks}=await twoChunks(db,at),first=chunks[0]!;
    const chunk=await readPageChunk({blobs},first),stored=blobs.objects.get(first.object_key!)!;
    const bytes=await encodePageChunk({...chunk,owners:[['conflicting',{thread:'source',record:'record'}],['unheld',{thread:'source',record:'second'}]]});
    blobs.objects.set(first.object_key!,{...stored,bytes,size:bytes.length});
    await metadataWith(db,blobs,async(k:string)=>k===first.object_key?null:blobs.get(k));
    await db.prepare("INSERT INTO document_owners VALUES('project','s',1,'conflicting','other','record')").run();
    expect(await repairPublicationMetadata(db,blobs,'project','s',at+30*MIN),target).toBe(false);
    expect(await failure(db),target).toEqual({failure:'document_ownership_conflict',failure_chunk:first.chunk_no});
    await repairPublicationMetadata(db,blobs,'project','s',at+31*MIN);
    expect(await failure(db),target).toEqual({failure:'document_ownership_conflict',failure_chunk:first.chunk_no});
    expect(await one(db,"SELECT COUNT(*) n FROM document_owners WHERE source_key='unheld'"),target).toEqual({n:0});
  });
});

test('a later chunk becoming readable does not clear an earlier chunk still unreadable',async()=>{
  await withDocumentStores(async(db,target)=>{
    const at=Date.now()-600*MIN,{blobs,chunks}=await twoChunks(db,at),first=chunks[0]!;
    await metadataWith(db,blobs,async(k:string)=>k===first.object_key?null:blobs.get(k));
    await repairPublicationMetadata(db,new Proxy(blobs,{get(store,key){return key==='get'?async()=>null:Reflect.get(store,key);}}),'project','s',at+30*MIN);
    await repairPublicationMetadata(db,without(blobs,first.object_key!),'project','s',at+31*MIN);
    expect(await failure(db),target).toEqual({failure:'document_object_missing',failure_chunk:first.chunk_no});
  });
});

test('catch-up reading a later chunk does not clear a failure the repair could not resolve',async()=>{
  await withDocumentStores(async(db,target)=>{
    const at=Date.now()-600*MIN,{blobs,chunks}=await twoChunks(db,at),first=chunks[0]!;
    await db.prepare('DELETE FROM document_owners').run();
    await db.prepare('DELETE FROM document_metadata_ready').run();
    await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL,generation=generation+1 WHERE projection='publication_ownership'").run();
    await catchUpPhase(db,'publicationMetadata',at+25*MIN,without(blobs,first.object_key!),()=>{});
    expect(await failure(db),target).toMatchObject({failure:'document_object_missing'});
    await repairPublicationMetadata(db,without(blobs,first.object_key!),'project','s',at+30*MIN);
    await catchUpProjections(db,{blobs,budget:{calls:1000,wallMs:60000}});
    expect(await failure(db),target).toEqual({failure:'document_object_missing',failure_chunk:first.chunk_no});
  });
});

test('a settled session whose metadata fails becomes due, keeps its signal, and recovers',async()=>{
  await withDocumentStores(async(db,target)=>{
    const at=Date.now()-600*MIN,{blobs,env,chunks}=await twoChunks(db,at);
    for(let n=0;n<5;n++)await publishDocuments(env,at+(21+n)*MIN,limits());
    expect(await one(db,"SELECT due_at FROM session_documents WHERE session_id='s'"),target).toEqual({due_at:null});
    await metadataWith(db,blobs,async(k:string)=>k===chunks[0]!.object_key?null:blobs.get(k));
    expect((await one(db,"SELECT due_at FROM session_documents WHERE session_id='s'"))!.due_at,target).not.toBeNull();
    await publishDocuments(env,Date.now()+8*24*60*MIN,limits());
    expect(await failure(db),target).toEqual({failure:null,failure_chunk:null});
  });
});

test('a transcript waiting for pin admission after its group is built still shares its declared scheme',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    await resetPins(db);
    await captureDocumentTranscript(db,blobs,'gap',id,user('turn','retained'),at,0,'codex');
    while(await catchUpPhase(db,'publicationPinGroups')){}
    expect(await one(db,"SELECT done FROM projection_catchup WHERE projection='publication_pins' AND phase='publicationPinsReady'"),target).toEqual({done:0});
    expect(await one(db,"SELECT prompt_identity_scheme FROM transcripts WHERE session_id='gap'"),target).toEqual({prompt_identity_scheme:null});
    expect(await sharesSessionScheme(db,'project','gap','codex-turn-v1'),target).toBe(true);
  });
});

test('a transcript already read before pins build is judged by the scheme the pin will give it',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    await resetPins(db);
    await captureDocumentTranscript(db,blobs,'read',id,user('turn','retained'),at,0,'codex');
    await db.prepare("UPDATE transcripts SET parsed_offset=1 WHERE session_id='read'").run();
    expect(await sharesSessionScheme(db,'project','read','codex-turn-v1'),target).toBe(false);
  });
});

test('both restore endpoints answer a named retryable conflict while pin initialization remains incomplete',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    const env=await captureDocumentTranscript(db,blobs,'restore',id,user('turn','retained'),at,0,'codex');
    await db.prepare("UPDATE members SET role='admin' WHERE id='member'").run();
    await db.prepare(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,first_received_at,last_received_at,token_id)
      SELECT 'project',value,'restore','machine','codex',0,1,1,'test' FROM json_each(?)`)
      .bind(JSON.stringify(Array.from({length:201},(_,i)=>'pending-'+i.toString().padStart(3,'0')))).run();
    await resetPins(db);
    const carried=await db.prepare('SELECT * FROM transcripts WHERE transcript_id=?').bind(id).first();
    const text=JSON.stringify({format:BACKUP_FORMAT,deploymentId:await deploymentId(db),schemaVersion:92,createdAt:1,producer:'publication test',counts:{transcripts:1}})
      +'\n'+JSON.stringify({t:'transcripts',r:carried});
    const bytes=new TextEncoder().encode(text),key='backups/publication-building.jsonl';
    await blobs.put(key,new Blob([bytes]).stream());
    await db.prepare(`INSERT INTO backups(id,key,created_at,size_bytes,schema_version,counts_json,producer,pinned)
      VALUES('building',?,1,?,92,'{"transcripts":1}','publication test',0)`).bind(key,bytes.length).run();
    for(const handler of [handleRestoreBackup,handleRestoreUpload]){
      const response=await handler(env,{request:new Request('https://fixture/restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({artifact:text})}),
        params:{backupId:'building'},member:{id:'member'},now:at} as never);
      expect(response.status,target).toBe(409);
      expect(await response.json(),target).toMatchObject({complete:false,error:'publication_restore_building',retryable:true,message:expect.stringContaining('retry the same restore')});
    }
  });
});

for(const [phase,refusal] of [['publicationPinsReady','publication_pins_building'],['publicationOwnershipReady','publication_ownership_building'],['publicationSessions','publication_inputs_building']] as const){
  test(`${phase} called before the phases it reads have finished refuses with ${refusal}`,async()=>{
    await withDocumentStores(async(db,target)=>{
      await resetProjectionCatchup(db);
      await expect(catchUpPhase(db,phase),target).rejects.toThrow(refusal);
    });
  },30_000);
}
