import {expect,it} from 'bun:test';
import {sessionMaterial,titleSession} from '@myco-server-worker/core/titling.js';
import {assertSessionSourceReady} from '@myco-server-worker/read/view-store.js';
import {captureViewSession,withViewStores} from './helpers/view-stores.js';
import {mirrorViewSession,publishMirroredSession,setViewCheckpointFailure} from './helpers/view-instances.js';
import {sqliteEnv} from './helpers/fixtures.js';
import {statementRecorder} from '../helpers/statement-recorder.js';

const scope={projectId:'project'};
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
