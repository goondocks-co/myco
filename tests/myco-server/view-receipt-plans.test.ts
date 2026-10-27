import {expect,it} from 'bun:test';
import {receiptPlans,withViewReadResponse} from '@myco-server-worker/read/view-store.js';
import {getSession} from '@myco-server-worker/read/sessions.js';
import {tombstoneSession} from '@myco-server-worker/core/tombstones.js';
import {captureViewSession,withViewStores} from './helpers/view-stores.js';
import {mirrorViewSession,publishMirroredSession,setViewLayerValues} from './helpers/view-instances.js';
import {mutateOriginalWorld,seedViewConsumerWorld,mirrorConsumerWorld} from './helpers/view-worlds.js';
import {selectSporesForPrompt} from '@myco-server-worker/core/injection.js';
import {sessionWriteAdmission} from '@myco-server-worker/ingest/projections.js';
import {reconcileEmbedding} from '@myco-server-worker/core/embedding/reconcile.js';
import {cloudflareVectorStore} from '@myco-server-worker/platform/cloudflare/vectors.js';
import {indexFixture} from './helpers/vector-index.js';
import {legacyBodyBlobs} from '../helpers/view-read-legacy-fixtures.js';
import {uuid} from './helpers/fixtures.js';
import {statementRecorder} from '../helpers/statement-recorder.js';

const scope={projectId:'project'};
it('historical exact-key fallbacks use the plan source session instead of the receiving session handle',async()=>{
 await withViewStores(async(db,target)=>{
  await captureViewSession(db,'project','source');
  await captureViewSession(db,'project','receiver',{idOffset:100});
  const request=[{receiptId:'historical',planIds:[uuid(50),'missing']}];
  const expected=await receiptPlans(db,scope,request);
  expect(expected.get('historical')?.[0]?.sessionId).toBe('source');
  for(const sessionId of ['source','receiver']){
   await mirrorViewSession(db,{...scope,sessionId,instanceId:sessionId+'-parent',state:'frozen'});
   await mirrorViewSession(db,{...scope,sessionId,instanceId:sessionId+'-tail',state:'live',parent:sessionId+'-parent'},false);
   await publishMirroredSession(db,'project',sessionId,sessionId+'-tail',sessionId+'-parent');
  }
  for(const world of ['poison','gone'] as const){
   await mutateOriginalWorld(db,world);
   await withViewReadResponse(db,()=>1,async bound=>{
    await getSession(bound,scope,'receiver');
    expect(await receiptPlans(bound,scope,request),target+' '+world).toEqual(expected);
   });
   const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native',captureRows:true});
   await withViewReadResponse(observed.db,()=>1,async bound=>{
    await getSession(bound,scope,'source');
    expect(await receiptPlans(bound,scope,request),target+' held source '+world).toEqual(expected);
   });
   const captures=observed.statements.flatMap(row=>row.rows??[]).filter(row=>typeof row==='object'&&row!==null&&'__myco_capture'in row&&row.__myco_capture!=null);
   expect(captures,target+' one source capture '+world).toHaveLength(1);
  }
  expect((await receiptPlans(db,{projectId:'other'},request)).get('historical')).toEqual([]);
 });
},60_000);

it('stored served snapshots retain explicit unavailability after a source tombstone',async()=>{
 await withViewStores(async(db,target)=>{
  await seedViewConsumerWorld(db);
  const vectors=cloudflareVectorStore(indexFixture()),provider={modelKey:'view-receipt-fixture',embed:async(text:string)=>{
   if(text.includes('CI background'))return [-1,0];
   if(text.includes('classified'))return [-1,0];
   if(text.includes('propagated'))return [0,1];
   if(text.includes('bundle'))return [0.7,0.7];
   if(text.includes('blob'))return [0.99,0.14];
   return [1,0];
  }};
  for(let iteration=0;iteration<100;iteration++)if((await reconcileEmbedding({db,blobs:legacyBodyBlobs,vectors,provider},'project',900)).processed===0)break;
  const selected=await selectSporesForPrompt(db,scope,{enabled:true,maxPerPrompt:7},true,{
   sessionId:'continued',promptId:null,scopeReason:'absent_key',promptHash:'cross-session-receipt',prompt:'baseline plan',now:1000,
   admission:sessionWriteAdmission({projectId:'project',machineId:'machine'},'continued'),
  },async()=>({vectors,provider:{...provider,embed:async()=>[1,0]}}));
  console.info('VIEW_RECEIPT_SELECTION',JSON.stringify({target,counts:selected.counts,skipped:selected.skipped,kinds:selected.items.map(item=>item.kind)}));
  expect(selected.items.some(item=>item.kind==='plan'),target+' served plan control').toBe(true);
  const rows=(await db.prepare(`SELECT s.receipt_id,s.item_id,s.session_id,r.session_id AS receiver FROM injection_served_items s
    JOIN spore_injections r ON r.project_id=s.project_id AND r.id=s.receipt_id
    WHERE s.project_id=? AND s.session_id<>r.session_id`).bind(scope.projectId).all<{receipt_id:string;item_id:string;session_id:string;receiver:string}>()).results;
  expect(rows.length,target+' cross-session served snapshots').toBeGreaterThan(0);
  const row=rows[0]!;
  await mirrorConsumerWorld(db);
  await tombstoneSession({db},scope,row.session_id,'member',1000);
  const result=(await receiptPlans(db,scope,[{receiptId:row.receipt_id,planIds:[row.item_id]}])).get(row.receipt_id);
  expect(result,target).toEqual([{planKey:row.item_id,title:null,sessionId:null,contentHash:null,unavailable:true}]);
 });
},60_000);

it('a receipt continuation keeps an absent owner after publication and still discovers unknown owners',async()=>{
 const differences:string[]=[];
 await withViewStores(async(db,target)=>{
  await captureViewSession(db,'project','source');
  await captureViewSession(db,'project','unknown',{idOffset:100});
  const request=[{receiptId:'historical',planIds:[uuid(50)]}];
  const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native',captureRows:true});
  const captures=()=>observed.statements.flatMap(query=>query.rows??[]).filter(row=>typeof row==='object'&&row!==null&&'__myco_capture'in row&&row.__myco_capture!=null);
  const reads=()=>observed.statements.reduce((total,query)=>{
   if(query.rowsRead===undefined)throw new Error('Missing D1 receipt work');return total+query.rowsRead;
  },0);
  await withViewReadResponse(observed.db,()=>1,async bound=>{
   await getSession(bound,scope,'source');await observed.drain();observed.reset();
   const before=await receiptPlans(bound,scope,request);await observed.drain();
   expect(captures(),target+' absent baseline').toHaveLength(0);
   const count=observed.statements.length,baseline=target==='D1'?reads():null;
   for(const sessionId of ['source','unknown']){
    await mirrorViewSession(db,{...scope,sessionId,instanceId:sessionId+'-live',state:'live'});
    await setViewLayerValues(db,'project',sessionId+'-live','published '+sessionId);
    await publishMirroredSession(db,'project',sessionId,sessionId+'-live');
   }
   observed.reset();
   expect(await receiptPlans(bound,scope,request),target+' retained absent result').toEqual(before);
   await observed.drain();
   if(captures().length!==0)differences.push(target+' reacquired the captured absent owner');
   if(observed.statements.length!==count)differences.push(target+' changed the continuation statement count');
   if(target==='D1'&&reads()!==baseline)differences.push(target+' continuation work '+reads()+' differs from absent baseline '+baseline);
   observed.reset();
   const fresh=await receiptPlans(bound,scope,[{receiptId:'unknown',planIds:[uuid(150)]}]);await observed.drain();
   expect(fresh.get('unknown')?.[0]?.title,target+' unknown owner').toBe('published unknown');
   expect(captures(),target+' one newly discovered owner').toHaveLength(1);
  });
 });
 expect(differences,'captured absent receipt owners require no new physical metadata').toEqual([]);
},60_000);
