import {expect,it} from 'bun:test';
import {withViewStores,captureViewSession} from './helpers/view-stores.js';
import {seedViewConsumerWorld,mirrorConsumerWorld,mutateOriginalWorld,activityConsumerWorld} from './helpers/view-worlds.js';

it('activity, lineage and both delivery sources retain their independent pre-mutation output',async()=>{
 await withViewStores(async(db,target)=>{
  await seedViewConsumerWorld(db);
  const expected=await activityConsumerWorld(db);
  await mirrorConsumerWorld(db);
  expect(await activityConsumerWorld(db),target+' parent').toEqual(expected);
  for(const world of ['poison','gone'] as const){
   await mutateOriginalWorld(db,world);
   expect(await activityConsumerWorld(db),target+' '+world).toEqual(expected);
  }
 });
},60_000);

import {sessionLineage,LINEAGE_MAX_DEPTH,LINEAGE_MAX_NODES} from '@myco-server-worker/read/lineage.js';

it('lineage preserves depth and node boundaries with published first-prompt labels on both targets',async()=>{
 await withViewStores(async(db,target)=>{
  for(let index=0;index<11;index++)await captureViewSession(db,'project','chain-'+index,{idOffset:15000000+index*100,parentSessionId:index===0?undefined:'chain-'+(index-1),promptText:'chain label '+index});
  await captureViewSession(db,'project','fan-root',{idOffset:15100000,promptText:'fan root'});
  for(let index=0;index<221;index++)await captureViewSession(db,'project','fan-'+String(index).padStart(3,'0'),{idOffset:15200000+index*100,launchParentSessionId:'fan-root',promptText:'fan label '+index});
  const selected=['chain-10','chain-0','fan-root'],expected=await Promise.all(selected.map(id=>sessionLineage(db,{projectId:'project'},id)));
  for(const value of expected){expect(value,target+' bounded family').not.toBeNull();expect(value!.truncated).toBe(true);}
  expect(Math.max(...expected[0]!.nodes.map(node=>node.depth))).toBe(LINEAGE_MAX_DEPTH);
  expect(expected[2]!.nodes).toHaveLength(LINEAGE_MAX_NODES);
  expect(expected[2]!.edges).toHaveLength(LINEAGE_MAX_NODES-1);
  await mirrorConsumerWorld(db);
  for(const world of ['parent','poison','gone'] as const){
   if(world!=='parent')await mutateOriginalWorld(db,world);
   expect(await Promise.all(selected.map(id=>sessionLineage(db,{projectId:'project'},id))),target+'/'+world).toEqual(expected);
  }
 });
},120_000);
