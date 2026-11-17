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
    f.sqlite.run('DELETE FROM spore_curation_unit_members');f.sqlite.run('DELETE FROM spore_curation_units');
    await initializeCurationHistory(f.db);
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
    await endLeasedRun(f.env,{principal:f.principal,now:f.now+11},{...scope,runId:claim.run.id,attemptId:claim.run.attemptId,status:'completed'});
    await pruneTerminalRuns(f.db,f.now+12,10);
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
      ['edited',"UPDATE spores SET content='Human edit',revision=revision+1 WHERE id=?",'was edited'],
      ['replaced',"UPDATE spores SET status='superseded',revision=revision+1 WHERE id=?",'is now replaced'],
      ['source',"UPDATE spores SET content='Changed original',revision=revision+1 WHERE id=?",'was edited'],
      ['missing','DELETE FROM spores WHERE id=?','is missing'],
    ]){
      const {source,target}=await merge(f,suffix!);
      f.sqlite.run('PRAGMA foreign_keys=OFF');f.sqlite.run(change!,[suffix==='source'||suffix==='missing'?source:target]);f.sqlite.run('PRAGMA foreign_keys=ON');
      const before=await Promise.all([getSpore(f.db,scope,source),getSpore(f.db,scope,target)]);
      expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:target,actor:'mem_worker',now:f.now+1}))
        .toMatchObject({ok:false,refusal:{noteId:suffix==='source'||suffix==='missing'?source:target,message:expect.stringContaining(words!)}});
      expect(await Promise.all([getSpore(f.db,scope,source),getSpore(f.db,scope,target)])).toEqual(before);
      expect((await sporeCurationUndo(f.db,scope,target))!.unit.undoneAt).toBeNull();
    }
    const {target}=await merge(f,'incomplete');
    f.sqlite.run('DELETE FROM spore_curation_unit_members WHERE unit_id=? AND role=\'source\'',[target]);
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:target,actor:'mem_worker',now:f.now+1}))
      .toMatchObject({ok:false,refusal:{code:'history_incomplete',message:expect.stringContaining('complete history')}});
    expect((await getSpore(f.db,scope,target))!.status).toBe('active');
    const damaged=await merge(f,'snapshot');
    f.sqlite.run("UPDATE spore_curation_unit_members SET after_json='{}' WHERE unit_id=? AND role='output'",[damaged.target]);
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:damaged.target,actor:'mem_worker',now:f.now+1})).toMatchObject({ok:false});
    expect((await getSpore(f.db,scope,damaged.source))!.status).toBe('consolidated');
    const legacy=await merge(f,'legacy-missing');
    f.sqlite.run('DELETE FROM spore_curation_units WHERE id=?',[legacy.target]);
    f.sqlite.run('DELETE FROM spores WHERE id=?',[legacy.target]);
    await initializeCurationHistory(f.db);
    expect((await sporeCurationUndo(f.db,scope,legacy.source))!.blocker).toMatchObject({noteId:legacy.target,message:expect.stringContaining('is missing')});
    expect(await undoSporeCuration(f.db,{projectId:'proj_1',unitId:legacy.target,actor:'mem_worker',now:f.now+1})).toMatchObject({ok:false,refusal:{code:'note_missing'}});
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
    expect(await undoSporeCuration(raced.store,options)).toMatchObject({ok:false,refusal:{noteId:target,message:expect.stringContaining('was edited')}});
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
