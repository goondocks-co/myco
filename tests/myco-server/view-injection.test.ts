import {expect,it} from 'bun:test';
import {withViewStores} from './helpers/view-stores.js';
import {seedViewConsumerWorld,mirrorConsumerWorld,mutateOriginalWorld,injectionConsumerWorld} from './helpers/view-worlds.js';
import {sessionTurnContexts} from '@myco-server-worker/read/turns.js';
import {mirrorViewSession,publishMirroredSession} from './helpers/view-instances.js';
import {statementRecorder} from '../helpers/statement-recorder.js';

it('direct turn-context composition retains the hint admission through a publication flip',async()=>{
 const evidence:{target:string;expected:unknown;actual:unknown}[]=[];
 await withViewStores(async(db,target)=>{
  await seedViewConsumerWorld(db);
  const expected=await sessionTurnContexts(db,{projectId:'project'},'session');
  expect(Object.keys(expected).length).toBeGreaterThan(0);
  await mirrorConsumerWorld(db);
  await mirrorViewSession(db,{projectId:'project',sessionId:'session',instanceId:'next',state:'building'},false);
  let flipped=false;
  const recorded=statementRecorder(db,{accounting:target==='D1'?'d1':'native',after:async row=>{
   if(!flipped&&row.sql.startsWith('/*vs:M08:')){flipped=true;await publishMirroredSession(db,'project','session','next')}
  }});
  const actual=await sessionTurnContexts(recorded.db,{projectId:'project'},'session');
  evidence.push({target,expected,actual});
 });
 console.info('VIEW_DIRECT_CONTEXT_FLIP',JSON.stringify(evidence));
 for(const row of evidence)expect(row.actual,row.target).toEqual(row.expected);
},60_000);

it('placement, context and served plan snapshots retain their independent pre-mutation output',async()=>{
 await withViewStores(async(db,target)=>{
  await seedViewConsumerWorld(db);
  const expected=await injectionConsumerWorld(db);
  await mirrorConsumerWorld(db);
  expect(await injectionConsumerWorld(db),target+' parent').toEqual(expected);
  for(const world of ['poison','gone'] as const){
   await mutateOriginalWorld(db,world);
   expect(await injectionConsumerWorld(db),target+' '+world).toEqual(expected);
  }
 });
},60_000);
