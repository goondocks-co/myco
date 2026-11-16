import { expect, test } from 'bun:test';
import { catchUpPhase, catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { publicationRebuildProgress } from '@myco-server-worker/db/documents/rebuild.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { PUBLICATION_REOPEN_PHASE } from '@myco-server-worker/db/documents/reopen.js';
import { PARSER_VERSION } from '@myco-server-worker/constants.js';
import { withDocumentStores, captureDocumentTranscript, captureDocumentSession } from './helpers/document-stores.js';
import { memoryBlobStore, readFixtureRecords } from './helpers/fixtures.js';
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


test('an admission revision retries stopped transcripts once without rebuilding healthy or tombstoned sessions',async()=>{
  await withDocumentStores(async(db,target)=>{
    const blobs=memoryBlobStore(),at=Date.now()-60*MIN;
    const healthy='tx_00000000000000000000000000000001',good='tx_00000000000000000000000000000004';
    const bad='tx_00000000000000000000000000000003',gone='tx_00000000000000000000000000000002',closed='tx_00000000000000000000000000000005';
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
      ['closed',closed,text,PARSER_VERSION,'scheme_conflict'],
    ] as const){
      await captureDocumentTranscript(db,blobs,session,id,body,at,0,'codex');
      await db.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,generation,session_id,published_offset,
        prompt_scheme,record_scheme,parser_version,state,failure,updated_at)
        VALUES('project',?,1,?,0,'codex-turn-v1','source-record-v1',?,'failed',?,1)`).bind(id,session,version,failure).run();
    }
    await db.prepare("INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES('project','gone',1,'owner')").run();
    await db.prepare("UPDATE session_documents SET due_at=NULL WHERE session_id<>'healthy'").run();
    await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE phase=?").bind(PUBLICATION_REOPEN_PHASE).run();
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
    expect(await one(db,"SELECT state,failure,published_offset,updated_at FROM transcript_publication WHERE session_id='closed'"),target)
      .toEqual({state:'failed',failure:'scheme_conflict',published_offset:0,updated_at:1});
    const stopped=await one(db,"SELECT state,failure,diagnostic FROM transcript_publication WHERE session_id='refused'");
    expect(stopped,target).toMatchObject({state:'failed',failure:'event_refused'});
    expect(JSON.parse(String(stopped!.diagnostic)),target).toMatchObject({branch:'event_refused',subreason:'unpaired_surrogate'});
    expect(await catchUpPhase(db,PUBLICATION_REOPEN_PHASE),target).toBe(0);
    await publishDocuments(env,at+22*MIN,limits());
    expect(await one(db,"SELECT state,failure,diagnostic FROM transcript_publication WHERE session_id='refused'"),target).toEqual(stopped);
  });
});


test('a stored transcript is read once after its parser becomes available', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), at = Date.now() - 60 * MIN;
    const text = [
      { type: 'user.message', id: 'user', data: { messageId: 'submission', content: 'retained question' } },
      { type: 'assistant.message', id: 'reply', data: { originatingMessageId: 'submission', content: 'retained answer' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    const member = await captureDocumentSession(db, 'project', 'fixture-member');
    await db.prepare(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,first_received_at,last_received_at,token_id,prompt_identity_scheme)
      VALUES('project','tx_10000000000000000000000000000001','catch-up','machine','copilot',?1,?1,?2,'hook-mint-v1')`).bind(at, member.tokenId).run();
    const env = await captureDocumentTranscript(db, blobs, 'catch-up', 'tx_10000000000000000000000000000001', text, at, 0, 'copilot');
    await db.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,generation,session_id,published_offset,
      prompt_scheme,record_scheme,parser_version,state,failure,updated_at)
      VALUES('project','tx_10000000000000000000000000000001',1,'catch-up',0,
        'hook-mint-v1','source-record-v1',0,'failed','parser_absent',?1)`).bind(at).run();
    await db.prepare("UPDATE session_documents SET due_at=NULL WHERE session_id='catch-up'").run();
    expect(await one(db, "SELECT state,failure FROM transcript_publication WHERE session_id='catch-up'"), target)
      .toEqual({ state: 'failed', failure: 'parser_absent' });
    await catchUpProjections(db, { blobs, budget: { calls: 500, wallMs: 60_000 } });
    await publishDocuments(env, at + 21 * MIN, limits());
    expect(await one(db, "SELECT prompt_identity_scheme FROM transcripts WHERE session_id='catch-up'"), target)
      .toEqual({ prompt_identity_scheme: 'hook-mint-v1' });
    const rows = await readFixtureRecords(env, 'project', 'catch-up');
    expect(rows.filter(row => row.k === 'prompt' || row.k === 'reply').map(row => row.text), target).toEqual(['retained question', 'retained answer']);
    await catchUpProjections(db, { blobs, budget: { calls: 500, wallMs: 60_000 } });
    await publishDocuments(env, at + 22 * MIN, limits());
    expect(await readFixtureRecords(env, 'project', 'catch-up'), target).toEqual(rows);
  });
});

test('a later reply snapshot replaces a narration already published for the same turn', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), at = Date.now() - 60 * MIN, id = 'tx_20000000000000000000000000000001';
    const line = (step_index: number, type: string, content: string) => JSON.stringify({ step_index, type, content }) + '\n';
    const first = line(0, 'USER_INPUT', 'retained question') + line(1, 'PLANNER_RESPONSE', 'Inspecting the orchard.');
    const env = await captureDocumentTranscript(db, blobs, 'snapshot', id, first, at, 0, 'antigravity');
    await publishDocuments(env, at + 20 * MIN, limits());
    expect((await readFixtureRecords(env, 'project', 'snapshot')).filter(row => row.k === 'reply').map(row => row.text), target)
      .toEqual(['Inspecting the orchard.']);
    await captureDocumentTranscript(db, blobs, 'snapshot', id, line(2, 'PLANNER_RESPONSE', 'The orchard has pears.'), at + 21 * MIN, Buffer.byteLength(first), 'antigravity');
    await publishDocuments(env, at + 40 * MIN, limits());
    expect((await readFixtureRecords(env, 'project', 'snapshot')).filter(row => row.k === 'reply').map(row => row.text), target)
      .toEqual(['The orchard has pears.']);
  });
});
