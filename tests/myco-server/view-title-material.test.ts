import {expect,it} from 'bun:test';
import {sessionMaterial,titleSession} from '@myco-server-worker/core/titling.js';
import {assertSessionSourceReady} from '@myco-server-worker/read/view-store.js';
import {captureViewSession,withViewStores} from './helpers/view-stores.js';
import {mirrorViewSession,publishMirroredSession,setViewCheckpointFailure,setViewCheckpointProgress} from './helpers/view-instances.js';
import {sessionMaterialRows,sessionMaterialTailRows} from '@myco-server-worker/read/children.js';
import {sqliteEnv,memoryBlobStore,uuid,envelope,recordingLimiter} from './helpers/fixtures.js';
import {statementRecorder} from '../helpers/statement-recorder.js';
import {handleBlob} from '@myco-server-worker/ingest/blobs.js';
import {ingestEvent} from '@myco-server-worker/ingest/events.js';
import {serverEnvFromBindings} from '@myco-server-worker/platform/cloudflare/env.js';
import {sha256HexOf} from '@myco-server-worker/hash.js';

const scope={projectId:'project'};
it('accepted lost context is ready for title and children material while an incomplete tail stays pending',async()=>{
 await withViewStores(async(db,target)=>{
  const issued=await captureViewSession(db);
  const bytes=new TextEncoder().encode('{}\n'),key=await sha256HexOf(bytes),transcript=uuid(700);
  const env=serverEnvFromBindings({MYCO_DB:db,BUCKET:memoryBlobStore(),SOURCE_LIMIT:recordingLimiter(),TOKEN_LIMIT:recordingLimiter()});
  const ctx={projectId:'project',machineId:'machine',tokenId:issued.tokenId,now:1,bodyBytes:0};
  expect((await handleBlob(env,new Request('https://local.example/blobs/'+key,{method:'POST',headers:{'content-type':'text/plain'},body:bytes}),{...ctx,clock:()=>1,contentLength:bytes.length,params:{key}})).ok).toBe(true);
  expect((await ingestEvent(db,ctx,envelope({eventId:uuid(701),sessionId:'session',kind:'transcript.segment',payload:{transcriptId:transcript,baseOffset:0,length:bytes.length,blob:key,agent:'claude-code'}}),{db,blobs:env.blobs})).persisted).toBe(true);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'parent',state:'frozen'});
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'live',state:'live',parent:'parent'},false);
  await publishMirroredSession(db,'project','session','live','parent');
  await setViewCheckpointFailure(db,'project','session','live',null);
  const reads=[()=>sessionMaterial(db,'project','session'),()=>sessionMaterialRows(db,'project','session',{limit:10,excerptChars:80}),()=>sessionMaterialTailRows(db,'project','session',{limit:10,excerptChars:80})];
  const expected=await Promise.all(reads.map(read=>read()));
  expect(expected.every(rows=>rows.length>0),target).toBe(true);
  await setViewCheckpointProgress(db,'project','live',transcript,bytes.length,1);
  expect(await Promise.all(reads.map(read=>read())),target+' accepted loss').toEqual(expected);
  await setViewCheckpointProgress(db,'project','live',transcript,0,1);
  for(const read of reads)await expect(read(),target+' pending').rejects.toThrow('Session capture is incomplete');
 });
},60_000);
it('title head and tail material use the frozen source after poisoned and gone originals',async()=>{
 await withViewStores(async(db,target)=>{
  await captureViewSession(db);
  const read=()=>Promise.all((['claim','owner','refresh'] as const).map(mode=>sessionMaterial(db,'project','session',mode)));
  const expected=await read();
  expect(expected.every(rows=>rows.length>0)).toBe(true);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'parent',state:'frozen'});
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'tail',state:'live',parent:'parent'},false);
  await publishMirroredSession(db,'project','session','tail','parent');
  await db.prepare("UPDATE prompt_batches SET text='poison',origin='system' WHERE project_id=?").bind('project').run();
  expect(await read(),target+' poison').toEqual(expected);
  await db.prepare("DELETE FROM prompt_batches WHERE project_id=?").bind('project').run();
  await db.prepare("DELETE FROM responses WHERE project_id=?").bind('project').run();
  expect(await read(),target+' gone').toEqual(expected);
 });
},60_000);

it('the captured live checkpoint refuses title material and every canonical claim before a write',async()=>{
 const base=sqliteEnv();
 await withViewStores(async(db,target)=>{
  await captureViewSession(db);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'live',state:'live'});
  await publishMirroredSession(db,'project','session','live');
  await assertSessionSourceReady(db,'project','session');
  await setViewCheckpointFailure(db,'project','session','live','parse failure');
  await expect(sessionMaterial(db,'project','session')).rejects.toThrow('Session capture is incomplete');
  for(const mode of ['claim','owner','refresh'] as const){
   const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native'});
   expect(await titleSession({...base.serverEnv,db:observed.db},{...scope,sessionId:'session',now:2000,origin:'https://local.example'},{mode})).toEqual({outcome:'capture_pending'});
   await observed.drain();
   expect(observed.statements.some(row=>(row.changes??0)!==0)).toBe(false);
  }
  await setViewCheckpointFailure(db,'project','session','live',null);
  expect((await sessionMaterial(db,'project','session')).length).toBeGreaterThan(0);
 });
},60_000);
