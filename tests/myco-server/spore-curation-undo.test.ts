import { expect,test } from 'bun:test';
import { changingAtStatement } from './helpers/store-faults.js';
import { pruneTerminalRuns } from '@myco-server-worker/db/runs/retention.js';
import { curationFixture as fixture,keepAnswer,note,scope } from './helpers/curation.js';
import { getSpore } from '@myco-server-worker/db/spores/records.js';
import { sporeCurationUndo,undoSporeCuration } from '@myco-server-worker/core/spore-curation-undo.js';
import { readCurationCoverage } from '@myco-server-worker/db/spores/curation-answer.js';
import { latestSporeResolution } from '@myco-server-worker/db/spores/resolutions.js';
import { listSupersedingSporeIds,listSupersededSporeIds } from '@myco-server-worker/db/spores/edges.js';
import { endLeasedRun } from '@myco-server-worker/core/harness.js';
import { searchDeployment } from '@myco-server-worker/core/search.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { NEXT_CURATION_UNDO } from '@myco-server-worker/db/schema-vNEXT-curation-undo.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { asOwner,asOwnerPost,OWNER_ENV,ownerCookie,MEMBER_SUB,seedMemberRoleAccount } from './helpers/owner.js';
import { initializeCurationHistory } from '@myco-server-worker/db/spores/curation-history.js';
import { consolidateSpores,resolveSpore,restoreSpore } from '@myco-server-worker/db/spores/lifecycle.js';

test('one undo restores a merge, split and retirement together, keeps dates, records lineage and stays settled',async()=>{
  const f=await fixture();
  try{
    await f.enable();f.sqlite.run("UPDATE members SET label='Ada' WHERE id='mem_worker'");
    const ids=['decision-a','decision-b','wisdom-c','gotcha-d','gotcha-e'];
    for(const [i,id] of ids.entries())await f.add(id,[1,0],10+i,'Original capture guidance '+id);
    const before=await Promise.all(ids.map(id=>getSpore(f.db,scope,id)));
    await f.discover();const claim=await f.poll();if(!claim.claimed)throw new Error('not claimed');
    const answer={...keepAnswer(['gotcha-e']),notes:[note(['decision-a','decision-b']),note(['wisdom-c'],'Situation one.'),note(['wisdom-c'],'Situation two.')],
      retire:[{id:'gotcha-d',reason:'Covered by the original guidance.',made_unnecessary_by:'new:0'}]};
    const applied=await f.call(claim.run.runToken,'myco_run_curation',answer) as {notes:{id:string}[]};
    await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{...scope,runId:claim.run.id,attemptId:claim.run.attemptId,status:'completed'});
    expect(await pruneTerminalRuns(f.db,f.now+2,10)).toBeGreaterThan(0);
    const preview=(await sporeCurationUndo(f.db,scope,applied.notes[0]!.id))!;
    expect(preview.unit.id).toBe(claim.run.id);expect(preview.blocker).toBeNull();
    expect((await sporeCurationUndo(f.db,scope,'decision-a'))!.unit.id).toBe(preview.unit.id);
    expect(preview.restore.map(note=>note.id).sort()).toEqual(ids.slice(0,4).sort());
    expect(preview.retire.map(note=>note.id).sort()).toEqual(applied.notes.map(note=>note.id).sort());
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:preview.unit.id,actor:'mem_worker',now:f.now+10})).toMatchObject({ok:true});
    for(const [i,id] of ids.slice(0,4).entries()){
      const restored=(await getSpore(f.db,scope,id))!;
      expect(restored).toMatchObject({status:'active',content:before[i]!.content,agentLine:before[i]!.agentLine,
        observationType:before[i]!.observationType,createdAt:before[i]!.createdAt,observedAt:before[i]!.observedAt,updatedAt:f.now+10});
      expect(await listSupersedingSporeIds(f.db,scope,id)).toEqual([]);
      expect(await latestSporeResolution(f.db,scope,id)).toMatchObject({action:'restore',author:'mem_worker',reason:expect.stringContaining('Curation undone by Ada')});
    }
    expect(await getSpore(f.db,scope,'gotcha-e')).toEqual(before[4]);
    for(const output of applied.notes){
      expect((await getSpore(f.db,scope,output.id))!.status).toBe('obsolete');
      expect((await latestSporeResolution(f.db,scope,output.id))!.reason).toContain('Curation undone by Ada');
    }
    expect((await listSupersededSporeIds(f.db,scope,applied.notes[0]!.id)).sort()).toEqual(['decision-a','decision-b']);
    const search=await searchDeployment(f.env,scope,{query:'capture',type:'spore',mode:'fts'},'member:test');
    expect(search.hits.map(hit=>hit.id).sort()).toEqual(ids.sort());
    expect(await readCurationCoverage(f.db,'proj_1')).toEqual({unconsidered:0,unevaluated:0});
    expect((await sporeCurationUndo(f.db,scope,applied.notes[0]!.id))!.unit.undoneAt).toBe(f.now+10);
    await f.discover();expect(await f.poll(f.now+12)).toMatchObject({claimed:false});
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:preview.unit.id,actor:'mem_worker',now:f.now+13}))
      .toMatchObject({ok:false,refusal:{code:'already_undone',message:expect.stringContaining('already undone')}});
  }finally{f.sqlite.close();}
});

test('an old merge survives history initialization twice and a later merge must be undone first',async()=>{
  const f=await fixture();
  try{
    await f.add('old-a',[1,0],f.now-10);await f.add('old-b',[1,0],f.now-9);
    const event={id:'old-retire',sporeId:'old-a',agentId:'myco-agent',author:null,reason:'The situation ended.',sessionId:null,createdAt:f.now-2};
    await resolveSpore(f.db,scope,{status:'obsolete',event:{...event,action:'obsolete',newSporeId:null},now:f.now-2});
    await restoreSpore(f.db,scope,{event:{...event,id:'old-restore',createdAt:f.now-1},now:f.now-1});
    const original=(await getSpore(f.db,scope,'old-a'))!;
    const merged={id:'wisdom-old',agentId:'myco-agent',sessionId:null,observationType:'wisdom',content:'Merged guidance.',context:null,filePath:null,tags:null,contentHash:null,properties:null,author:null,agentLine:'When capture changes, preserve history.',createdAt:f.now};
    await consolidateSpores(f.db,scope,{wisdom:merged,sources:[{id:'old-a',revision:2},{id:'old-b',revision:0}],
      event:{agentId:'myco-agent',author:null,reason:'One situation.',sessionId:null,createdAt:f.now},now:f.now});
    await consolidateSpores(f.db,scope,{wisdom:{...merged,id:'wisdom-middle',createdAt:f.now+1},sources:[{id:'wisdom-old',revision:0}],event:{agentId:'myco-agent',author:null,reason:'Old child merge.',sessionId:null,createdAt:f.now+1},now:f.now+1});
    f.sqlite.run('DELETE FROM spore_curation_unit_members');f.sqlite.run('DELETE FROM spore_curation_units');
    for(let repeat=0;repeat<2;repeat++)await f.db.batch(SCHEMA_STEPS.find(step=>step.version===NEXT_CURATION_UNDO)!.statements.map(sql=>f.db.prepare(sql)));
    expect((await sporeCurationUndo(f.db,scope,'wisdom-middle'))!.blocker).toBeNull();
    await consolidateSpores(f.db,scope,{wisdom:{...merged,id:'wisdom-later',createdAt:f.now+1},sources:[{id:'wisdom-middle',revision:0}],
      event:{agentId:'myco-agent',author:null,reason:'Later merge.',sessionId:null,createdAt:f.now+1},now:f.now+1});
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:'wisdom-old',actor:'mem_worker',now:f.now+2}))
      .toMatchObject({ok:false,refusal:{noteId:'wisdom-old',laterUnitId:'wisdom-middle',message:expect.stringContaining('Undo that curation first')}});
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:'wisdom-later',actor:'mem_worker',now:f.now+3})).toMatchObject({ok:true});
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:'wisdom-middle',actor:'mem_worker',now:f.now+4})).toMatchObject({ok:true});
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:'wisdom-old',actor:'mem_worker',now:f.now+5})).toMatchObject({ok:true});
    expect(await getSpore(f.db,scope,'old-a')).toMatchObject({status:'active',content:original.content,createdAt:original.createdAt});
  }finally{f.sqlite.close();}
});

const merge = async(f:Awaited<ReturnType<typeof fixture>>,suffix:string)=>{
  const source='source-'+suffix,target='wisdom-'+suffix;await f.add(source);
  await consolidateSpores(f.db,scope,{wisdom:{id:target,agentId:'myco-agent',sessionId:null,observationType:'wisdom',content:'Merged '+suffix,context:null,filePath:null,tags:null,contentHash:null,properties:null,author:null,agentLine:'When changing capture, keep history.',createdAt:f.now},sources:[{id:source,revision:0}],event:{agentId:'myco-agent',author:null,reason:'One situation.',sessionId:null,createdAt:f.now},now:f.now});
  return {source,target};
};

test('undo names edited, replaced and missing notes, rejects incomplete history and leaves each unit unchanged',async()=>{
  const f=await fixture();
  try{
    for(const [suffix,change,words] of [
      ['edited',"UPDATE spores SET content='Human edit',revision=revision+1 WHERE id=?",'different body'],
      ['replaced',"UPDATE spores SET status='superseded',revision=revision+1 WHERE id=?",'was replaced'],
      ['source',"UPDATE spores SET content='Changed original',revision=revision+1 WHERE id=?",'different body'],
      ['missing','DELETE FROM spores WHERE id=?','no longer held'],
      ['source-retired',"UPDATE spores SET status='obsolete',revision=revision+1 WHERE id=?",'was retired by hand'],
    ]){
      const {source,target}=await merge(f,suffix!);
      f.sqlite.run('PRAGMA foreign_keys=OFF');f.sqlite.run(change!,[suffix==='source'||suffix==='source-retired'||suffix==='missing'?source:target]);f.sqlite.run('PRAGMA foreign_keys=ON');
      const before=await Promise.all([getSpore(f.db,scope,source),getSpore(f.db,scope,target)]);
      expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:target,actor:'mem_worker',now:f.now+1}))
        .toMatchObject({ok:false,refusal:{noteId:suffix==='source'||suffix==='source-retired'||suffix==='missing'?source:target,message:expect.stringContaining(words!)}});
      expect(await Promise.all([getSpore(f.db,scope,source),getSpore(f.db,scope,target)])).toEqual(before);
      expect((await sporeCurationUndo(f.db,scope,target))!.unit.undoneAt).toBeNull();
    }
    const {target}=await merge(f,'incomplete');
    f.sqlite.run('DELETE FROM spore_curation_unit_members WHERE unit_id=? AND role=\'source\'',[target]);
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:target,actor:'mem_worker',now:f.now+1}))
      .toMatchObject({ok:false,refusal:{code:'history_incomplete',message:expect.stringContaining('can no longer be undone')}});
    expect((await getSpore(f.db,scope,target))!.status).toBe('active');
    const damaged=await merge(f,'snapshot');
    f.sqlite.run("UPDATE spore_curation_unit_members SET after_json='{}' WHERE unit_id=? AND role='output'",[damaged.target]);
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:damaged.target,actor:'mem_worker',now:f.now+1})).toMatchObject({ok:false});
    expect((await getSpore(f.db,scope,damaged.source))!.status).toBe('consolidated');
    const legacy=await merge(f,'legacy-missing');
    f.sqlite.run('DELETE FROM spore_curation_units WHERE id=?',[legacy.target]);
    f.sqlite.run('DELETE FROM spores WHERE id=?',[legacy.target]);
    await initializeCurationHistory(f.db);
    expect((await sporeCurationUndo(f.db,scope,legacy.source))!.blocker).toBeNull();
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:legacy.target,actor:'mem_worker',now:f.now+1})).toMatchObject({ok:true});
    expect((await getSpore(f.db,scope,legacy.source))!.status).toBe('active');
  }finally{f.sqlite.close();}
});

test('an undo rolls back after writing events, rechecks races and requires a live administrator',async()=>{
  const f=await fixture();
  try{
    const {source,target}=await merge(f,'failure');
    const before=await Promise.all([getSpore(f.db,scope,source),getSpore(f.db,scope,target)]);
    const options={projectId:'proj_1',unitId:target,actor:'mem_worker',now:f.now+1};
    f.sqlite.run("CREATE TRIGGER fail_undo BEFORE UPDATE ON spores WHEN NEW.status='active' BEGIN SELECT RAISE(ABORT,'fixture undo failure'); END");
    await expect(undoSporeCuration(f.db,options)).rejects.toThrow('fixture undo failure');
    expect(await latestSporeResolution(f.db,scope,target)).toBeNull();
    expect(await Promise.all([getSpore(f.db,scope,source),getSpore(f.db,scope,target)])).toEqual(before);
    expect((await sporeCurationUndo(f.db,scope,target))!.blocker).toBeNull();
    f.sqlite.run('DROP TRIGGER fail_undo');
    const raced=changingAtStatement(f.db,'curationUndo.admitted',()=>f.sqlite.run("UPDATE spores SET content='Concurrent edit',revision=revision+1 WHERE id=?",[target]));
    expect(await undoSporeCuration(raced.store,options)).toMatchObject({ok:false,refusal:{noteId:target,message:expect.stringContaining('different body')}});
    const fresh=await merge(f,'authority');
    expect(await undoSporeCuration(f.db,{...options,unitId:fresh.target,actor:'mem_harness'})).toMatchObject({ok:false,refusal:{code:'not_admin',message:expect.stringContaining('active administrator')}});
    expect((await getSpore(f.db,scope,fresh.source))!.status).toBe('consolidated');
  }finally{f.sqlite.close();}
});


test('only an admin session can preview and undo a Project unit through the serving routes',async()=>{
  const f=await fixture();
  try{
    seedMemberRoleAccount(f.sqlite);const {source,target}=await merge(f,'routes');
    const server=createServer({now:()=>f.now,sourceOf:()=> '127.0.0.1',fetchImpl:fetch});
    const serve=(request:Request)=>server.handleRequest(request,{...f.env,secrets:OWNER_ENV});
    const preview='/api/projects/proj_1/spores/'+source+'/curation',undo='/api/projects/proj_1/curation/'+target+'/undo';
    expect(await (await serve(await asOwner(f.db,preview))).json()).toMatchObject({curation:{unit:{id:target},blocker:null}});
    const member=await ownerCookie(f.db,f.now,MEMBER_SUB);
    for(const [path,method] of [[preview,'GET'],[undo,'POST']])expect((await serve(new Request('https://s'+path,{method,headers:{cookie:member,origin:'https://s','content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})}))).status).toBe(403);
    expect((await serve(await asOwnerPost(f.db,undo.replace('proj_1','proj_2'),{}))).status).toBe(404);
    expect(await (await serve(await asOwnerPost(f.db,undo,{}))).json()).toMatchObject({ok:true});
    expect((await getSpore(f.db,scope,source))!.status).toBe('active');
  }finally{f.sqlite.close();}
});

async function resolveInto(f:Awaited<ReturnType<typeof fixture>>,source:string,target:string,action:'consolidate'|'supersede',at:number){
  const id=crypto.randomUUID();
  expect(await resolveSpore(f.db,scope,{status:action==='consolidate'?'consolidated':'superseded',now:at,event:{id,sporeId:source,newSporeId:target,
    action,agentId:'myco-agent',author:null,sessionId:null,reason:'The target carries this guidance.',createdAt:at}})).toBe(true);
  return id;
}

test('later consolidate and supersede links block the creator; each one-source undo preserves its existing target',async()=>{
  const f=await fixture();
  try{
    const {source,target}=await merge(f,'incoming');const output=(await getSpore(f.db,scope,target))!;
    for(const [id,action] of [['late-merge','consolidate'],['late-replace','supersede']] as const){
      await f.add(id);const operation=await resolveInto(f,id,target,action,f.now+1);
      expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:target,actor:'mem_worker',now:f.now+2}))
        .toMatchObject({ok:false,refusal:{code:'incoming_resolution',noteId:id,outputId:target,laterUnitId:operation,
          message:expect.stringContaining(action==='consolidate'?'was later merged into':'was later replaced by')}});
      expect((await getSpore(f.db,scope,source))!.status).toBe('consolidated');expect(await getSpore(f.db,scope,target)).toEqual(output);
      await initializeCurationHistory(f.db);
      const preview=(await sporeCurationUndo(f.db,scope,id))!;
      expect(preview.restore.map(note=>note.id)).toEqual([id]);expect(preview.retire).toEqual([]);
      expect(preview.leave).toEqual([{id:target,label:output.agentLine??target,status:'active'}]);
      expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:operation,actor:'mem_worker',now:f.now+3})).toMatchObject({ok:true});
      expect((await getSpore(f.db,scope,id))!.status).toBe('active');expect(await listSupersedingSporeIds(f.db,scope,id)).toEqual([]);
      expect(await getSpore(f.db,scope,target)).toEqual(output);
    }
    const repeated=await resolveInto(f,'late-merge',target,'consolidate',f.now+4);
    expect(await listSupersedingSporeIds(f.db,scope,'late-merge')).toEqual([target]);
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:repeated,actor:'mem_worker',now:f.now+5})).toMatchObject({ok:true});
    await f.add('recipient');const consuming=await resolveInto(f,target,'recipient','consolidate',f.now+6);
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:target,actor:'mem_worker',now:f.now+7}))
      .toMatchObject({ok:false,refusal:{laterUnitId:consuming,laterNoteId:target}});
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:consuming,actor:'mem_worker',now:f.now+8})).toMatchObject({ok:true});
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:target,actor:'mem_worker',now:f.now+9})).toMatchObject({ok:true});
    expect((await getSpore(f.db,scope,source))!.status).toBe('active');
    await f.enable();await f.discover();expect(await f.poll(f.now+10)).toMatchObject({claimed:false});
  }finally{f.sqlite.close();}
});

test('legacy units refuse a pre-existing target and distinct merge instants without changing knowledge',async()=>{
  const f=await fixture();
  try{
    await f.add('existing-target',[1,0],f.now-100_000,'Knowledge unique to the existing target.');await f.add('absorbed');
    await resolveInto(f,'absorbed','existing-target','consolidate',f.now);
    const {source,target}=await merge(f,'separate');await f.add('later');await resolveInto(f,'later',target,'consolidate',f.now+50_000);
    f.sqlite.run('DELETE FROM spore_curation_units');await initializeCurationHistory(f.db);
    for(const [unitId,words] of [['existing-target','existed before notes were merged into it'],[target,'separate operations']]){
      const original=(await getSpore(f.db,scope,unitId!))!;
      expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:unitId!,actor:'mem_worker',now:f.now+60_000}))
        .toMatchObject({ok:false,refusal:{noteId:unitId,message:expect.stringContaining(words!)}});
      expect(await getSpore(f.db,scope,unitId!)).toEqual(original);
    }
    expect((await getSpore(f.db,scope,source))!.status).toBe('consolidated');
    const lost=await merge(f,'lost-history');f.sqlite.run('DELETE FROM spore_curation_units WHERE id=?',[lost.target]);
    f.sqlite.run('PRAGMA foreign_keys=OFF');f.sqlite.run('DELETE FROM spores WHERE id=?',[lost.source]);f.sqlite.run('PRAGMA foreign_keys=ON');
    await initializeCurationHistory(f.db);
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:lost.target,actor:'mem_worker',now:f.now+60_001}))
      .toMatchObject({ok:false,refusal:{noteId:lost.source,message:expect.stringContaining(lost.source)}});

  }finally{f.sqlite.close();}
});

test('legacy pre-101 sources and an already retired output remain undoable after provenance is cleared',async()=>{
  const f=await fixture();
  try{
    await f.add('old-source');f.sqlite.run("UPDATE spores SET prompt_id='old-prompt' WHERE id='old-source'");
    const source=(await getSpore(f.db,scope,'old-source'))!;
    await consolidateSpores(f.db,scope,{wisdom:{id:'old-output',agentId:'myco-agent',sessionId:null,observationType:'wisdom',content:'Merged knowledge.',agentLine:'When changing capture, preserve its history.',context:null,filePath:null,tags:null,contentHash:null,properties:null,author:null,createdAt:f.now},
      sources:[{id:'old-source',revision:0}],event:{agentId:'myco-agent',author:null,sessionId:null,reason:'One merge.',createdAt:f.now},now:f.now});
    f.sqlite.run('UPDATE spores SET revision=0');f.sqlite.run('DELETE FROM spore_curation_units');await initializeCurationHistory(f.db);
    f.sqlite.run("UPDATE spores SET prompt_id=NULL WHERE id='old-source'");
    await resolveSpore(f.db,scope,{status:'obsolete',event:{id:'hand-retire',sporeId:'old-output',agentId:'myco-agent',action:'obsolete',newSporeId:null,reason:'Bad merge.',author:null,sessionId:null,createdAt:f.now+1},now:f.now+1});
    const retired=await getSpore(f.db,scope,'old-output');
    const preview=(await sporeCurationUndo(f.db,scope,'old-output'))!;expect(preview.blocker).toBeNull();expect(preview.retire).toEqual([]);
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:'old-output',actor:'mem_worker',now:f.now+2})).toMatchObject({ok:true});
    expect(await getSpore(f.db,scope,'old-source')).toMatchObject({status:'active',content:source.content,agentLine:source.agentLine,createdAt:source.createdAt});
    expect(await getSpore(f.db,scope,'old-output')).toEqual(retired);
    const reference=f.sqlite.query("SELECT prompt_id FROM spores WHERE id='old-source'").get();expect(reference).toEqual({prompt_id:null});
  }finally{f.sqlite.close();}
});

test('a hand-restored output and cleared references do not block undoing its child and parent',async()=>{
  const f=await fixture();
  try{
    const {source,target}=await merge(f,'hand');
    await resolveSpore(f.db,scope,{status:'obsolete',event:{id:'hand-out-retire',sporeId:target,agentId:'myco-agent',action:'obsolete',newSporeId:null,reason:'Bad merge.',author:null,sessionId:null,createdAt:f.now+1},now:f.now+1});
    await restoreSpore(f.db,scope,{event:{id:'hand-out-restore',sporeId:target,agentId:'myco-agent',reason:null,author:null,sessionId:null,createdAt:f.now+2},now:f.now+2});
    f.sqlite.run("UPDATE spores SET prompt_id='child-prompt' WHERE id=?",[target]);
    await consolidateSpores(f.db,scope,{wisdom:{id:'hand-child',agentId:'myco-agent',sessionId:null,observationType:'wisdom',content:'The child guidance.',agentLine:'When changing capture, preserve its history.',context:null,filePath:null,tags:null,contentHash:null,properties:null,author:null,createdAt:f.now+3},sources:[{id:target,revision:2}],
      event:{agentId:'myco-agent',author:null,sessionId:null,reason:'Child merge.',createdAt:f.now+3},now:f.now+3});
    f.sqlite.run("UPDATE spores SET prompt_id=NULL,session_id=NULL WHERE id IN (?,?)",[source,target]);
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:'hand-child',actor:'mem_worker',now:f.now+4})).toMatchObject({ok:true});
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:target,actor:'mem_worker',now:f.now+5})).toMatchObject({ok:true});
    expect((await getSpore(f.db,scope,source))!.status).toBe('active');
  }finally{f.sqlite.close();}
});

test('a restored original is named as current again, without advice to roll back a Project',async()=>{
  const f=await fixture();
  try{
    await f.enable();await f.add('retired-original');await f.add('kept-original');await f.discover();
    const claim=await f.poll();if(!claim.claimed)throw new Error('not claimed');
    expect(await f.call(claim.run.runToken,'myco_run_curation',{...keepAnswer(['kept-original']),retire:[{id:'retired-original',reason:'Covered.',made_unnecessary_by:'kept-original'}]})).toMatchObject({completed:true});
    await restoreSpore(f.db,scope,{event:{id:'hand-original-restore',sporeId:'retired-original',agentId:'myco-agent',reason:null,author:null,sessionId:null,createdAt:f.now+4},now:f.now+4});
    const result=await undoSporeCuration(f.db,{projectId:'proj_1',unitId:claim.run.id,actor:'mem_worker',now:f.now+5});
    const message=result.ok?'':result.refusal.message;
    expect(result).toMatchObject({ok:false,refusal:{noteId:'retired-original',message:expect.stringContaining('was restored by hand and is current again')}});
    expect(message).not.toContain('backup');
  }finally{f.sqlite.close();}
});

test('a curation whose output a later curation retired is undone only after that one, and a note that was not current gets no undo of its own',async()=>{
  const f=await fixture();
  try{
    await f.enable();await f.add('x1');await f.add('x2');
    const run=async(body:Record<string,unknown>)=>{
      for(let i=0;i<8;i++)await f.discover();
      const claim=await f.poll();if(!claim.claimed)throw new Error('not claimed');
      const applied=await f.call(claim.run.runToken,'myco_run_curation',body) as {notes?:{id:string}[]};
      await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{...scope,runId:claim.run.id,attemptId:claim.run.attemptId,status:'completed'});
      return {unit:claim.run.id,notes:applied.notes??[]};
    };
    const status=async(id:string)=>(await getSpore(f.db,scope,id))!.status;
    const undo=(unitId:string,now:number)=>undoSporeCuration(f.db,{projectId:'proj_1',unitId,actor:'mem_worker',now});
    const first=await run({...keepAnswer([]),notes:[note(['x1','x2'])]});const output=first.notes[0]!.id;
    await f.add(output,[1,0],f.now+5);await f.add('k1',[1,0],f.now+6);
    const later=await run({...keepAnswer(['k1']),retire:[{id:output,reason:'Covered by k1.',made_unnecessary_by:'k1'}]});
    expect(await undo(first.unit,f.now+10)).toMatchObject({ok:false});
    expect([await status('x1'),await status('x2'),await status(output)]).toEqual(['consolidated','consolidated','obsolete']);
    expect(await undo(later.unit,f.now+11)).toMatchObject({ok:true});
    expect(await undo(first.unit,f.now+12)).toMatchObject({ok:true});
    expect([await status('x1'),await status('x2'),await status(output)]).toEqual(['active','active','obsolete']);

    await f.add('was-retired');await f.add('successor');
    await resolveSpore(f.db,scope,{status:'obsolete',now:f.now,event:{id:'retire-1',sporeId:'was-retired',agentId:'myco-agent',action:'obsolete',newSporeId:null,reason:'Wrong.',author:null,sessionId:null,createdAt:f.now}});
    await resolveSpore(f.db,scope,{status:'superseded',now:f.now+1,expect:{status:'obsolete'},event:{id:'supersede-1',sporeId:'was-retired',agentId:'myco-agent',action:'supersede',newSporeId:'successor',reason:'Replaced.',author:null,sessionId:null,createdAt:f.now+1}});
    expect(await undo('supersede-1',f.now+13)).toMatchObject({ok:false});
    expect(await status('was-retired')).toBe('superseded');
  }finally{f.sqlite.close();}
});
