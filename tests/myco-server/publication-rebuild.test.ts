import { expect, test } from 'bun:test';
import { catchUpPhase } from '@myco-server-worker/db/projections/catchup.js';
import { publicationRebuildProgress } from '@myco-server-worker/db/documents/rebuild.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
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
