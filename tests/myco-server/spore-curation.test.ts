import { searchDeployment } from '@myco-server-worker/core/search.js';
import { expect, test } from 'bun:test';
import { endLeasedRun, dispatchTask } from '@myco-server-worker/core/harness.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { curationAssignment } from '@myco-server-worker/core/spore-curation.js';
import { runCloseRefusal } from '@myco-server-worker/core/run-postconditions.js';
import { CURATION_BODY_CHARS, CURATION_NEW_NOTES } from '@myco-server-worker/core/spore-curation-contract.js';
import { getSpore } from '@myco-server-worker/db/spores/records.js';
import { listSupersedingSporeIds, listSupersededSporeIds } from '@myco-server-worker/db/spores/edges.js';
import { readCurationAnswer, readCurationCoverage } from '@myco-server-worker/db/spores/curation-answer.js';
import { CURATION_ANSWER_STEPS } from '@myco-server-worker/db/schema-steps-curation-answer.js';
import { curationFixture as fixture, keepAnswer, note, scope } from './helpers/curation.js';

test('guidance admits routes and prose while refusing deterministic file, identifier, flag and call notation', async () => {
  const refused = ['see packages/myco-server/src/core/x.ts', 'read core/spore-curation.ts', 'look at worker-steps.test.ts',
    'call capture_spool', 'When MYCO_HOME is unset', 'call retry() on the queue', 'pass --force to the CLI', 'see ~/myco/config'];
  const accepted = ['a path like /api/projects', 'Node.js(22)', 'exit code 1(retry)', 'check outboxLease', 'run npm run check:pr',
    'measure myco hook startup', 'When a session (or its turns) is retried, keep the canonical identity.',
    'When budgets hit the cap (5 per day), wait for the next window.', 'When guidance is short-lived (e.g. hotfix), retire it soon.',
    'When the CI run fails, rerun just the failed shard.', 'When D1 batches exceed 100 statements, split them.'];
  for (const line of [...refused, ...accepted]) {
    const f=await fixture();
    try {
      await f.enable(); await f.add('decision-a'); await f.add('gotcha-b'); await f.discover();
      await dispatchTask(f.env,'curate-spores','proj_1',{serverUrl:'https://fixture.test',actor:'mem_worker',options:{dryRun:true}},f.now);
      const claim=await f.poll(); if(!claim.claimed)throw new Error('preview not claimed');
      const result=await f.call(claim.run.runToken,'myco_run_curation',{...keepAnswer(['gotcha-b']),notes:[{...note(['decision-a']),agent_line:line}]});
      expect(result).toMatchObject(refused.includes(line) ? {ok:false,error:expect.stringContaining('contains code notation')} : {completed:true,applied:false});
    } finally {f.sqlite.close();}
  }
});

test('the curation schema can reapply twice with existing decisions and recompute live coverage', async () => {
  const f=await fixture();
  try {
    await f.enable(); await f.add('decision-a'); await f.add('gotcha-b'); await f.discover();
    const claim=await f.poll();if(!claim.claimed)throw new Error('group not claimed');
    await f.call(claim.run.runToken,'myco_run_curation',keepAnswer(['decision-a','gotcha-b']));
    await f.add('wisdom-c',[0,1],f.now+1,'No calibration yet.',null); await f.discover();
    const original=await getSpore(f.db,scope,'decision-a');
    for(let replay=0;replay<2;replay++) {
      f.sqlite.run('UPDATE spore_curation_coverage SET unconsidered=0,unevaluated=0');
      for(const statement of CURATION_ANSWER_STEPS[0]!.statements) {
        try {f.sqlite.exec(statement);}
        catch(error) {if(!/duplicate column name/i.test((error as Error).message))throw error;}
      }
      expect(await readCurationCoverage(f.db,'proj_1')).toEqual({unconsidered:1,unevaluated:1});
      expect(await getSpore(f.db,scope,'decision-a')).toEqual(original);
    }
  }finally{f.sqlite.close();}
});

test('one answer merges, splits, keeps and retires atomically with observed dates and all lineage', async () => {
  const f = await fixture();
  try {
    await f.enable();
    for (const [id, date] of [['decision-a', f.now], ['decision-b', 20], ['wisdom-c', 15], ['gotcha-d', 5], ['gotcha-e', 1]] as const)
      await f.add(id, [1,0], date);
    await f.add('decision-origin', [1,0], 10);
    f.sqlite.run("UPDATE spores SET status='consolidated' WHERE project_id='proj_1' AND id='decision-origin'");
    f.sqlite.run("INSERT INTO resolution_events(id,project_id,agent_id,spore_id,new_spore_id,action,reason,created_at) VALUES('legacy-consolidation','proj_1','myco-agent','decision-origin','decision-a','consolidate','Merged the same situation.',?)", [f.now]);
    await f.discover();
    const claim = await f.poll(); if (!claim.claimed) throw new Error('group not claimed');
    expect(claim.run.profile).toMatchObject({ model: 'sonnet', effort: 'low' });
    expect((await f.list(claim.run.runToken)).map(tool => tool.name)).toEqual(['myco_run_curation']);
    expect(claim.run).not.toHaveProperty('repository');
    const before = await getSpore(f.db, scope, 'gotcha-d');
    const answer = { op: 'answer', notes: [note(['decision-a','decision-b']), note(['wisdom-c'], 'When capturing a turn, retain its canonical identity.'), note(['wisdom-c'], 'When delivering a turn, retain it until acknowledged.')],
      keep: ['gotcha-d'], retire: [{id:'gotcha-e',reason:'Its guidance is already covered.',made_unnecessary_by:'new:0'}], reason:'Merged one situation, split two situations, retained distinct guidance and retired a redundant note.' };
    expect(await f.call(claim.run.runToken,'myco_run_curation', answer)).toMatchObject({completed:true,applied:true});
    expect(await f.call(claim.run.runToken,'myco_run_curation', answer)).toMatchObject({completed:true,applied:true});
    const stored = await readCurationAnswer(f.db,'proj_1',claim.run.id);
    const checked = JSON.parse(stored!.answer!) as { notes: {id:string;createdAt:number;updatedAt:number}[] };
    expect(checked.notes.every(item=>item.updatedAt===f.now)).toBe(true);
    expect(checked.notes.map(item=>item.createdAt)).toEqual([20,15,15]);
    expect((await getSpore(f.db,scope,checked.notes[0]!.id))!.sourceCreatedAt).toBeNull();
    expect(await getSpore(f.db,scope,'gotcha-d')).toEqual(before);
    expect((await getSpore(f.db,scope,'gotcha-e'))!.status).toBe('obsolete');
    expect((await getSpore(f.db,scope,'wisdom-c'))!.status).toBe('consolidated');
    expect((await listSupersedingSporeIds(f.db,scope,'wisdom-c')).sort()).toEqual(checked.notes.slice(1).map(item=>item.id).sort());
    expect((await listSupersededSporeIds(f.db,scope,checked.notes[0]!.id)).sort()).toEqual(['decision-a','decision-b']);
    const found=await searchDeployment(f.env,scope,{query:'delivery stalls',type:'spore',mode:'fts'},'member:fixture');
    expect(found.hits.find(hit=>hit.id===checked.notes[0]!.id)?.learned_at).toBe(new Date(20).toISOString());
    const historical=await searchDeployment(f.env,scope,{query:'wisdom',type:'spore',status:'all',mode:'fts'},'member:fixture');
    expect(historical.hits.find(hit=>hit.id==='wisdom-c')?.successor_ids?.sort()).toEqual(checked.notes.slice(1).map(item=>item.id).sort());
    expect(await readCurationCoverage(f.db,'proj_1')).toEqual({unconsidered:0,unevaluated:0});
    expect(await runCloseRefusal(f.db,scope,(await getRun(f.db,scope,claim.run.id))!)).toBeNull();
    await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{projectId:'proj_1',runId:claim.run.id,attemptId:claim.run.attemptId,status:'completed'});
    await f.discover(); expect(await f.poll()).toMatchObject({claimed:false});
  } finally { f.sqlite.close(); }
});

test('an invalid answer changes no notes and its one correction may succeed', async () => {
  const f=await fixture();
  try {
    await f.enable(); await f.add('decision-a'); await f.add('gotcha-b'); await f.discover();
    const claim=await f.poll(); if(!claim.claimed) throw new Error('group not claimed');
    const before=await getSpore(f.db,scope,'decision-a');
    const refused=await f.call(claim.run.runToken,'myco_run_curation',{...keepAnswer(['gotcha-b']),notes:[note(['a'])]}) as {error:string};
    expect(refused.error).toContain('id "a" is not an exact assigned member id');
    expect(refused.error).toContain('Repair only the named field or disposition');
    expect(JSON.parse(refused.error.split('Next call: myco_run_curation ')[1]!.slice(0,-1))).toMatchObject({notes:[note(['a'])],keep:['gotcha-b']});
    expect(await getSpore(f.db,scope,'decision-a')).toEqual(before);
    expect(await readCurationCoverage(f.db,'proj_1')).toEqual({unconsidered:0,unevaluated:0});
    expect(await f.call(claim.run.runToken,'myco_run_curation',keepAnswer(['decision-a','gotcha-b']))).toMatchObject({completed:true});
    expect(await readCurationCoverage(f.db,'proj_1')).toEqual({unconsidered:0,unevaluated:0});
  } finally { f.sqlite.close(); }
});

test('refusals name coverage, bounds and lexical code notation; exhausted attempts cannot apply', async () => {
  const cases = [
    { answer: {keep:['decision-a','gotcha-b'],reason:'   '}, error:'reason has 0 non-whitespace (3 raw) characters' },
    { answer: {notes:[note(['decision-a'],'x'.repeat(CURATION_BODY_CHARS+1))],keep:['gotcha-b']}, error: `content has ${CURATION_BODY_CHARS+1} characters; expected 1–${CURATION_BODY_CHARS}` },
    { answer: {notes:Array.from({length:CURATION_NEW_NOTES+1},()=>note(['decision-a'])),keep:['gotcha-b']}, error: `notes has ${CURATION_NEW_NOTES+1} entries; limit ${CURATION_NEW_NOTES}` },
    { answer: {keep:['decision-a']}, error:'answer omits 1 members' },
    { answer: {notes:[{...note(['decision-a']),agent_line:'Use capture_spool() to retain data.'}],keep:['gotcha-b']}, error:'contains code notation' },
    { answer: {notes:[note(['decision-a'])],keep:['decision-a','gotcha-b']}, error:'occurs in both sources and keep' },
    { answer: {keep:['decision-a'],retire:[{id:'gotcha-b',reason:'External evidence.',made_unnecessary_by:'outside'}]}, error:'expected a kept member id' },
  ];
  for(const item of cases) {
    const f=await fixture();
    try {
      await f.enable();await f.add('decision-a');await f.add('gotcha-b');await f.discover();
      const claim=await f.poll();if(!claim.claimed)throw new Error('group not claimed');
      const input={...keepAnswer([]),...item.answer};
      const result=await f.call(claim.run.runToken,'myco_run_curation',input) as {error:string};
      expect(result.error).toContain(item.error);
      expect(result.error).toContain('Not saved: curation answer');
      expect(result.error).toContain('Next call: myco_run_curation');
      await f.call(claim.run.runToken,'myco_run_curation',input);
      expect(await f.call(claim.run.runToken,'myco_run_curation',keepAnswer(['decision-a','gotcha-b']))).toMatchObject({ok:false,error:expect.stringContaining('make no further call')});
      expect((await getSpore(f.db,scope,'decision-a'))!.status).toBe('active');
      expect((await readCurationAnswer(f.db,'proj_1',claim.run.id))!.answer).toBeNull();
      await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{projectId:'proj_1',runId:claim.run.id,attemptId:claim.run.attemptId,status:'completed'});
      expect((await getRun(f.db,scope,claim.run.id))!.status).toBe('failed');
    } finally {f.sqlite.close();}
  }
});

test('a stale group saves no answer and is offered again at the changed revision',async()=>{
  const f=await fixture();
  try {
    await f.enable(); await f.add('decision-a'); await f.add('gotcha-b'); await f.discover();
    const claim=await f.poll(); if(!claim.claimed)throw new Error('group not claimed');
    f.sqlite.run("UPDATE spores SET revision=revision+1,content='New guidance',updated_at=? WHERE id='decision-a'",[f.now+1]);
    expect(await f.call(claim.run.runToken,'myco_run_curation',{...keepAnswer([]),notes:[note(['decision-a','gotcha-b'])]})).toMatchObject({code:'material_changed',error:expect.stringContaining('make no further call')});
    expect((await getSpore(f.db,scope,'gotcha-b'))!.status).toBe('active');
    expect((await readCurationAnswer(f.db,'proj_1',claim.run.id))!.answer).toBeNull();
    expect(await readCurationCoverage(f.db,'proj_1')).toEqual({unconsidered:1,unevaluated:0});
    await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{projectId:'proj_1',runId:claim.run.id,attemptId:claim.run.attemptId,status:'failed'});
    f.sqlite.run('UPDATE spore_curation_work SET due_at=?',[f.now]);
    await f.poll(); await f.add('decision-a'); await f.discover();
    const next=await f.poll(); expect(next.claimed).toBe(true);
    if(next.claimed)expect(curationAssignment((await getRun(f.db,scope,next.run.id))!.runContext)!.members).toContainEqual({id:'decision-a',revision:1});
  }finally{f.sqlite.close();}
});

test('a dry run stores its checked group answer without lifecycle changes or review receipts',async()=>{
  const f=await fixture();
  try {
    await f.enable();await f.add('decision-a');await f.add('gotcha-b');await f.discover();
    const queued=await dispatchTask(f.env,'curate-spores','proj_1',{serverUrl:'https://fixture.test',actor:'mem_worker',options:{dryRun:true}},f.now);
    expect(queued).toMatchObject({queued:true});
    const claim=await f.poll();if(!claim.claimed)throw new Error('preview not claimed');
    expect((await getRun(f.db,scope,claim.run.id))!.dryRun).toBe(1);
    expect((await f.list(claim.run.runToken)).map(tool=>tool.name)).toEqual(['myco_run_curation']);
    expect(await f.call(claim.run.runToken,'myco_run_curation',{...keepAnswer([]),notes:[note(['decision-a','gotcha-b'])]})).toMatchObject({completed:true,applied:false});
    expect((await readCurationAnswer(f.db,'proj_1',claim.run.id))!.applied).toBe(0);
    expect((await getSpore(f.db,scope,'decision-a'))!.status).toBe('active');
    expect(await readCurationCoverage(f.db,'proj_1')).toEqual({unconsidered:0,unevaluated:0});
    expect(await runCloseRefusal(f.db,scope,(await getRun(f.db,scope,claim.run.id))!)).toBeNull();
    await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{projectId:'proj_1',runId:claim.run.id,attemptId:claim.run.attemptId,status:'completed'});
    expect((await f.poll()).claimed).toBe(true);
  }finally{f.sqlite.close();}
});

test('a seed offered no group records consideration at its revision; later vector evidence can still group it',async()=>{
  const f=await fixture();
  try {
    await f.enable();await f.add('decision-a');await f.discover();
    expect(await f.poll()).toMatchObject({claimed:false});
    expect(await readCurationCoverage(f.db,'proj_1')).toEqual({unconsidered:0,unevaluated:0});
    await f.add('gotcha-b'); await f.discover(); expect((await f.poll()).claimed).toBe(true);
  }finally{f.sqlite.close();}
});
