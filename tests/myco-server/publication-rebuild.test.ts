import { expect, test } from 'bun:test';
import { catchUpPhase } from '@myco-server-worker/db/projections/catchup.js';
import { publicationRebuildProgress } from '@myco-server-worker/db/documents/rebuild.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { NEXT_PUBLICATION_REOPEN } from '@myco-server-worker/db/schema-vNEXT-publication-reopen.js';
import { PUBLICATION_REOPEN_PHASE } from '@myco-server-worker/db/documents/reopen.js';
import { PARSER_VERSION } from '@myco-server-worker/constants.js';
import { withDocumentStores, captureDocumentTranscript } from './helpers/document-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { limits, MIN, one, reply, user } from './helpers/document-publication.js';

test('version rebuild swaps the generation without losing stored records, identities or blobs', async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN,id='tx_0123456789abcdef0123456789abcdef';
    const env=await captureDocumentTranscript(db,blobs,'session',id,user('turn','prompt')+reply('answer'),at,0,'codex');
    await publishDocuments(env,at+20*MIN,limits());
    const source=(await db.prepare('SELECT * FROM transcripts').all()).results;
    const prompts=(await db.prepare('SELECT prompt_id,preview FROM session_prompts ORDER BY prompt_id').all()).results;
    const chunks=(await db.prepare('SELECT chunk_no,blob_key,source_id FROM session_chunks ORDER BY chunk_no').all()).results;
    await db.prepare('UPDATE transcript_publication SET parser_version=?').bind(PARSER_VERSION-1).run();
    await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE phase='publicationRebuildV6'").run();
    expect(await catchUpPhase(db,'publicationRebuildV6'),target).toBe(1);
    expect(await one(db,'SELECT generation,due_at,prompts,replies FROM session_documents'),target).toEqual({generation:2,due_at:0,prompts:1,replies:1});
    expect((await db.prepare('SELECT * FROM transcripts').all()).results,target).toEqual(source);
    expect((await db.prepare('SELECT prompt_id,preview FROM session_prompts ORDER BY prompt_id').all()).results,target).toEqual(prompts);
    expect((await db.prepare('SELECT chunk_no,blob_key,source_id FROM session_chunks ORDER BY chunk_no').all()).results,target).toEqual(chunks);
    await publishDocuments(env,at+21*MIN,limits());
    expect(await one(db,'SELECT generation,due_at,prompts,replies FROM session_documents'),target).toEqual({generation:2,due_at:null,prompts:1,replies:1});
    expect(await catchUpPhase(db,'publicationRebuildV6'),target).toBe(0);
    expect(await publicationRebuildProgress(db),target).toEqual({state:'ready',versions:[{version:PARSER_VERSION,total:1,rebuilt:1}]});
    await db.prepare('UPDATE transcript_publication SET parser_version=? WHERE generation=2').bind(PARSER_VERSION-1).run();
    await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE phase='publicationRebuildV6'").run();
    expect(await catchUpPhase(db,'publicationRebuildV6'),target).toBe(1);
    expect(await one(db,'SELECT generation,due_at FROM session_documents'),target).toEqual({generation:3,due_at:0});
    expect((await db.prepare('SELECT prompt_id,preview FROM session_prompts ORDER BY prompt_id').all()).results,target).toEqual(prompts);
    expect(await publicationRebuildProgress(db),target).toEqual({state:'building',versions:[{version:PARSER_VERSION,total:1,rebuilt:0}]});
  });
});

test('version reopen arms only older reopenable failures and preserves newer stops and closed failures',async()=>{
  await withDocumentStores(async(db,target)=>{
    await db.prepare("INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES('project','session','live',1,1)").run();
    for(const [id,version,failure]of [['zero',0,'event_refused'],['old',PARSER_VERSION-1,'event_refused'],['new',PARSER_VERSION,'event_refused'],['closed',PARSER_VERSION-1,'scheme_conflict']] as const)
      await db.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,generation,session_id,published_offset,record_scheme,parser_version,state,failure,updated_at)
        VALUES('project',?,1,'session',12,'source-record-v1',?,'failed',?,1)`).bind(id,version,failure).run();
    await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE phase='publicationReopenV6'").run();
    expect(await catchUpPhase(db,'publicationReopenV6'),target).toBe(1);
    expect(await catchUpPhase(db,'publicationReopenV6'),target).toBe(1);
    expect((await db.prepare('SELECT transcript_id,state,published_offset FROM transcript_publication ORDER BY transcript_id').all()).results,target).toEqual([
      {transcript_id:'closed',state:'failed',published_offset:12},{transcript_id:'new',state:'failed',published_offset:12},{transcript_id:'old',state:'active',published_offset:0},{transcript_id:'zero',state:'active',published_offset:0},
    ]);
    expect(await one(db,'SELECT due_at FROM session_documents'),target).toEqual({due_at:0});
    expect(await catchUpPhase(db,'publicationReopenV6'),target).toBe(0);
  });
});


test('an admission upgrade retries stopped transcripts once without rebuilding healthy or tombstoned sessions',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    const healthy='tx_00000000000000000000000000000001',good='tx_00000000000000000000000000000004';
    const bad='tx_00000000000000000000000000000003',gone='tx_00000000000000000000000000000002';
    const text=user('reopened','retained prompt')+reply('retained answer');
    const env=await captureDocumentTranscript(db,blobs,'healthy',healthy,user('healthy','unchanged')+reply('kept'),at,0,'codex');
    await publishDocuments(env,at+20*MIN,limits());
    const snapshot=async()=>Promise.all(['session_documents','transcript_publication','session_prompts','session_chunks','session_pages']
      .map(async table=>(await db.prepare(`SELECT ${table==='transcript_publication'?'transcript_id,generation,published_offset,state,failure,parser_version,updated_at':'*'} FROM ${table} WHERE session_id='healthy'`).all()).results));
    const before=await snapshot();
    for(const [session,id,body,version,failure] of [
      ['reopened',good,text,PARSER_VERSION,'event_refused'],
      ['refused',bad,user('bad','\ud800'),PARSER_VERSION-1,'record_too_large'],
      ['gone',gone,text,PARSER_VERSION,'event_refused'],
    ] as const){
      await captureDocumentTranscript(db,blobs,session,id,body,at,0,'codex');
      await db.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,generation,session_id,published_offset,
        prompt_scheme,record_scheme,parser_version,state,failure,updated_at)
        VALUES('project',?,1,?,0,'codex-turn-v1','source-record-v1',?,'failed',?,1)`).bind(id,session,version,failure).run();
    }
    await db.prepare("INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES('project','gone',1,'owner')").run();
    await db.prepare("UPDATE session_documents SET due_at=NULL WHERE session_id<>'healthy'").run();
    for(const step of SCHEMA_STEPS.filter(step=>step.version>=NEXT_PUBLICATION_REOPEN))
      await db.batch(step.statements.map(sql=>db.prepare(sql)));
    for(let pass=0;pass<8;pass++){
      const previous=await one(db,"SELECT state,diagnostic FROM transcript_publication WHERE session_id='refused'");
      const changed=await catchUpPhase(db,PUBLICATION_REOPEN_PHASE);
      if(previous!.diagnostic!==null)expect(await one(db,"SELECT state,diagnostic FROM transcript_publication WHERE session_id='refused'"),target).toEqual(previous);
      await publishDocuments(env,at+21*MIN,limits());
      if(changed===0)break;
      expect(pass,target).toBeLessThan(7);
    }
    expect(await one(db,"SELECT generation,prompts,replies,due_at FROM session_documents WHERE session_id='reopened'"),target)
      .toEqual({generation:1,prompts:1,replies:1,due_at:null});
    expect(await one(db,'SELECT state,failure,diagnostic,published_offset,parser_version FROM transcript_publication WHERE transcript_id=?',good),target)
      .toEqual({state:'active',failure:null,diagnostic:null,published_offset:text.length,parser_version:PARSER_VERSION});
    expect(await snapshot(),target).toEqual(before);
    expect(await one(db,"SELECT state,failure,published_offset FROM transcript_publication WHERE session_id='gone'"),target)
      .toEqual({state:'failed',failure:'event_refused',published_offset:0});
    const stopped=await one(db,"SELECT state,failure,diagnostic FROM transcript_publication WHERE session_id='refused'");
    expect(stopped,target).toMatchObject({state:'failed',failure:'event_refused'});
    expect(JSON.parse(String(stopped!.diagnostic)),target).toMatchObject({branch:'event_refused',subreason:'unpaired_surrogate'});
    expect(await catchUpPhase(db,PUBLICATION_REOPEN_PHASE),target).toBe(0);
    await publishDocuments(env,at+22*MIN,limits());
    expect(await one(db,"SELECT state,failure,diagnostic FROM transcript_publication WHERE session_id='refused'"),target).toEqual(stopped);
  },NEXT_PUBLICATION_REOPEN-1);
});
