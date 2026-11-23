import { createServer } from '@myco-server-worker/pipeline.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { asOwner, asOwnerPost, OWNER_ENV, ownerCookie, MEMBER_SUB, seedMemberRoleAccount } from './helpers/owner.js';
import { issueMemberToken } from './helpers/member-token.js';
import { searchDeployment } from '@myco-server-worker/core/search.js';
import { expect, test } from 'bun:test';
import { endLeasedRun, dispatchTask, prepareDispatch, enqueueDispatch } from '@myco-server-worker/core/harness.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { answerSporeCuration, curationAssignment } from '@myco-server-worker/core/spore-curation.js';
import { runCloseRefusal } from '@myco-server-worker/core/run-postconditions.js';
import { CURATION_BODY_CHARS, CURATION_NEW_NOTES } from '@myco-server-worker/core/spore-curation-contract.js';
import { AGENT_LINE_MAX_CHARS } from '@myco-server-worker/core/injection.js';
import { getSpore } from '@myco-server-worker/db/spores/records.js';
import { listSporePage } from '@myco-server-worker/core/spores.js';
import { SEARCH_WINDOW } from '@goondocks/myco-shared/search-types';
import { NOTE_ORIGIN_STEPS } from '@myco-server-worker/db/schema-steps-note-origin.js';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { listSupersedingSporeIds, listSupersededSporeIds } from '@myco-server-worker/db/spores/edges.js';
import { readCurationAnswer, readCurationCoverage } from '@myco-server-worker/db/spores/curation-answer.js';
import { CURATION_ANSWER_STEPS } from '@myco-server-worker/db/schema-steps-curation-answer.js';
import { curationFixture as fixture, keepAnswer, note, scope } from './helpers/curation.js';

test('a curation answer is checked for code notation like every other agent line', async () => {
  const refused = ['When the queue stalls, inspect (~/myco/config) first.'];
  const accepted = ['When using Bun/Node.js for workers, compare the native library versions.'];
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

test('a member whose stored agent_line carries code notation is named to the run, refused as a keep, and accepted rewritten from itself or merged once', async () => {
  const body = 'Detection alone is not responsibility: reconcile in cli/member.ts; E_OWNED appears after 3 retries.';
  for (const merged of [false, true]) {
    const f = await fixture();
    try {
      await f.enable(); await f.add('decision-a', [1,0], f.now, body); await f.add('gotcha-b');
      f.sqlite.run("UPDATE spores SET agent_line='For machine agent status, reconcile owned registrations (cli/member.ts).' WHERE id='decision-a'");
      await f.discover();
      const claim = await f.poll(); if (!claim.claimed) throw new Error('group not claimed');
      expect(claim.run.instruction).toContain('"line_check":"The agent_line carries code notation \\"cli/member.ts\\"."');
      expect(claim.run.instruction!.split('"line_check"')).toHaveLength(2);
      const kept = await f.call(claim.run.runToken, 'myco_run_curation', keepAnswer(['decision-a', 'gotcha-b'])) as { error: string };
      expect(kept.error).toContain('member "decision-a" cannot be kept as it is: The agent_line carries code notation "cli/member.ts". Remove it from keep and write it again as a new note with sources ["decision-a"]');
      const rewrite = note(merged ? ['decision-a', 'gotcha-b'] : ['decision-a'], `When a machine shows another agent as its own, check what it registered. ${body}`);
      const done = await f.call(claim.run.runToken, 'myco_run_curation', { ...keepAnswer(merged ? [] : ['gotcha-b']), notes: [rewrite] }) as { applied: boolean; notes: { id: string }[] };
      const id = done.notes[0]!.id; expect(done).toMatchObject({ applied: true, notes: [{ id }] });
      expect((await getSpore(f.db, scope, id))!.content).toContain(body);
      expect((await getSpore(f.db, scope, 'decision-a'))!.status).toBe('consolidated');
      expect(await listSupersedingSporeIds(f.db, scope, 'decision-a')).toEqual([id]);
    } finally { f.sqlite.close(); }
  }
});

test('a marked member whose body is already at the limit can be written again with its old line moved into the body, and no further', async () => {
  const f = await fixture(), line = 'For machine agent status, reconcile owned registrations (cli/member.ts).', limit = CURATION_BODY_CHARS + line.length, answer = (chars: number) => ({ ...keepAnswer(['gotcha-b']), notes: [note(['decision-a'], 'y'.repeat(chars))] });
  try { await f.enable(); await f.add('decision-a', [1,0], f.now, 'x'.repeat(CURATION_BODY_CHARS)); await f.add('gotcha-b'); f.sqlite.run('UPDATE spores SET agent_line=? WHERE id=?', [line, 'decision-a']); await f.discover();
    const claim = await f.poll(); if (!claim.claimed) throw new Error('group not claimed'); expect(claim.run.instruction).toContain(`"body_limit":${limit}`);
    expect((await f.call(claim.run.runToken, 'myco_run_curation', answer(limit + 1)) as { error: string }).error).toContain(`it has ${limit + 1} characters, 1 more than the ${limit} allowed`); expect(await f.call(claim.run.runToken, 'myco_run_curation', answer(limit))).toMatchObject({ completed: true, applied: true }); } finally { f.sqlite.close(); } });
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
    expect(claim.run.profile).toMatchObject({ model: 'sonnet', effort: 'medium' });
    expect((await f.list(claim.run.runToken)).map(tool => tool.name)).toEqual(['myco_run_curation']);
    expect(claim.run).not.toHaveProperty('repository');
    const before = await getSpore(f.db, scope, 'gotcha-d');
    const answer = { op: 'answer', notes: [note(['decision-a','decision-b']), note(['wisdom-c'], 'When capturing a turn, retain its canonical identity.'), note(['wisdom-c'], 'When delivering a turn, retain it until acknowledged.')],
      keep: ['gotcha-d'], retire: [{id:'gotcha-e',reason:'Its guidance is already covered.',made_unnecessary_by:'new:0'}], reason:'Merged one situation, split two situations, retained distinct guidance and retired a redundant note.' };
    expect(await f.call(claim.run.runToken,'myco_run_curation', answer)).toMatchObject({completed:true,applied:true});
    expect(await f.call(claim.run.runToken,'myco_run_curation', answer)).toMatchObject({completed:true,applied:true});
    const stored = await readCurationAnswer(f.db,'proj_1',claim.run.id);
    const checked = JSON.parse(stored!.answer!) as { notes: {id:string;createdAt:number;observedAt:number;updatedAt:number}[] };
    expect(checked.notes.every(item=>item.updatedAt===f.now)).toBe(true);
    expect(checked.notes.map(item=>[item.observedAt,item.createdAt])).toEqual([[20,f.now],[15,f.now],[15,f.now]]);
    expect((await getSpore(f.db,scope,checked.notes[0]!.id))!.sourceCreatedAt).toBeNull();
    const listed=new Map((await listSporePage(f.db,scope,{limit:50}))!.rows.map(row=>[row.id,row]));
    expect(checked.notes.map(item=>[listed.get(item.id)?.origin,listed.get(item.id)?.sources])).toEqual([['curated',2],['curated',1],['curated',1]]);
    expect([listed.get('gotcha-d')?.origin,listed.get('wisdom-c')?.supersededBy?.sort()]).toEqual(['saved',checked.notes.slice(1).map(item=>item.id).sort()]);
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

test('a rewrite is dated by when it was written, so a common word\'s newest window finds it first; the upgrade dates an older rewrite so and moves no other note', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('decision-a', [1,0], 1); await f.add('gotcha-b'); await f.discover();
    const claim = await f.poll(); if (!claim.claimed) throw new Error('group not claimed');
    const id = (await f.call(claim.run.runToken, 'myco_run_curation', { ...keepAnswer(['gotcha-b']), notes: [note(['decision-a'])] }) as { notes: { id: string }[] }).notes[0]!.id;
    // More than one window of notes holding the same words, written after its source was observed.
    const insert = f.sqlite.prepare("INSERT INTO spores(project_id,id,agent_id,content,observation_type,agent_line,created_at) VALUES('proj_1',?,'myco-agent',?,'gotcha',?,?)");
    f.sqlite.transaction(() => { for (let i = 0; i <= SEARCH_WINDOW; i++) insert.run(`gotcha-${i}`, `Seen ${i}.`, 'When delivery stalls, retain queued capture.', 2 + i); })();
    const found = async () => (await searchDeployment(f.env, scope, { query: 'delivery stalls', type: 'spore', mode: 'fts' }, 'member:fixture')).hits;
    const rewrite = (await getSpore(f.db, scope, id))!;
    expect([rewrite.createdAt, rewrite.observedAt, (await found())[0]?.id, (await found())[0]?.learned_at]).toEqual([f.now, 1, id, new Date(1).toISOString()]);
    // A rewrite an earlier release dated by its source is dated by its write time again after the upgrade's catch-up, which moves no other note.
    f.sqlite.run("UPDATE spores SET created_at=1 WHERE project_id='proj_1' AND id=?", [id]);
    const dates = () => f.sqlite.query<{ id: string; created_at: number }, []>("SELECT id,created_at FROM spores WHERE project_id='proj_1' ORDER BY id").all();
    const before = dates();
    f.sqlite.run("DELETE FROM projection_catchup WHERE projection='spore_written_at'");
    for (const statement of NOTE_ORIGIN_STEPS[0]!.statements) f.sqlite.exec(statement);
    while ((await catchUpProjections(f.db)).more);
    expect(dates().filter((row, i) => row.created_at !== before[i]!.created_at)).toEqual([{ id, created_at: f.now }]);
    expect((await found())[0]?.id).toBe(id);
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

test('a note body is counted in characters with spaces and line breaks: the instruction states the limit, 1501 refuses the whole answer naming the excess, and 1500 and 1499 are kept', async () => {
  const f=await fixture();
  try {
    await f.enable(); await f.add('decision-a'); await f.add('gotcha-b'); await f.discover();
    const claim=await f.poll(); if(!claim.claimed) throw new Error('group not claimed');
    const instruction=claim.run.instruction!;
    expect(instruction).toContain(`at most ${CURATION_BODY_CHARS} characters, counting every character of the content including spaces`);
    expect(instruction).toContain('is refused whole');
    const body=(chars:number)=>'When delivery stalls, retain queued capture.\n\nKeep it until acknowledged. '.repeat(40).slice(0,chars);
    const split=(first:number)=>({...keepAnswer(['gotcha-b']),notes:[note(['decision-a'],body(first)),note(['decision-a'],body(CURATION_BODY_CHARS-1))]});
    const refused=await f.call(claim.run.runToken,'myco_run_curation',split(CURATION_BODY_CHARS+1)) as {error:string};
    expect(refused.error).toContain(`Not saved: curation answer; notes[0].content is longer than the note body limit: it has ${CURATION_BODY_CHARS+1} characters, 1 more than the ${CURATION_BODY_CHARS} allowed, counting spaces and line breaks; shorten that body by at least 1 character; submission 1 of 2.`);
    expect((await readCurationAnswer(f.db,'proj_1',claim.run.id))!.answer).toBeNull();
    expect(await f.call(claim.run.runToken,'myco_run_curation',split(CURATION_BODY_CHARS))).toMatchObject({completed:true,applied:true});
    const stored=JSON.parse((await readCurationAnswer(f.db,'proj_1',claim.run.id))!.answer!) as {answer:{notes:{content:string}[]}};
    expect(stored.answer.notes.map(kept=>kept.content.length)).toEqual([CURATION_BODY_CHARS,CURATION_BODY_CHARS-1]);
  } finally { f.sqlite.close(); }
});

test('myco_agent op run serves a failed curation run’s refusals from the same recorded tool calls as the dashboard', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('decision-a'); await f.add('gotcha-b'); await f.discover();
    const claim = await f.poll(); if (!claim.claimed) throw new Error('group not claimed');
    const over = CURATION_BODY_CHARS + 1;
    await f.call(claim.run.runToken, 'myco_run_curation', { ...keepAnswer(['gotcha-b']), notes: [note(['decision-a'], 'x'.repeat(over))] });
    await f.call(claim.run.runToken, 'myco_run_curation', { ...keepAnswer(['gotcha-b']), notes: [{ ...note(['decision-a']), agent_line: 'Use capture_spool() to retain data.' }] });
    const ended = await endLeasedRun(f.env, { principal: f.principal, now: f.now + 1 }, { ...scope, runId: claim.run.id, attemptId: claim.run.attemptId, status: 'completed' });
    expect(ended).toMatchObject({ ended: true, status: 'failed' });
    const member = await issueMemberToken(f.db, { memberId: 'mem_worker', machineId: 'refusal-reader' }, f.now);
    const agent = await f.call(member.token, 'myco_agent', { op: 'run', id: claim.run.id }) as { ok: boolean; data: { run: { error_reason: string | null }; reports: unknown[]; refusals: Array<{ tool: string; op: string | null; code: string; message: string; recorded_at: number }>; refusals_has_more: boolean } };
    expect(agent).toMatchObject({ ok: true, data: { run: { error_reason: null }, reports: [], refusals_has_more: false } });
    expect(agent.data.refusals).toHaveLength(2);
    expect(agent.data.refusals[0]).toMatchObject({ tool: 'myco_run_curation', op: 'answer', code: 'tool_failure', message: expect.stringContaining(`it has ${over} characters, 1 more than the ${CURATION_BODY_CHARS} allowed`), recorded_at: f.now });
    expect(agent.data.refusals[1]).toMatchObject({ tool: 'myco_run_curation', op: 'answer', code: 'tool_failure', message: expect.stringContaining('contains code notation'), recorded_at: f.now });
    const server = createServer({ now: () => f.now, sourceOf: () => '127.0.0.1', fetchImpl: fetch });
    const page = await server.handleRequest(await asOwner(f.db, `/api/projects/proj_1/runs/${claim.run.id}`), { ...f.env, secrets: OWNER_ENV });
    const dashboard = await page.json() as { toolCalls: Array<{ tool: string; op: string | null; failure?: { code: string; message: string } }> };
    expect(agent.data.refusals.map(({ tool, op, code, message }) => ({ tool, op, code, message }))).toEqual(
      dashboard.toolCalls.filter((call) => call.failure !== undefined).map((call) => ({ tool: call.tool, op: call.op, code: call.failure!.code, message: call.failure!.message })),
    );
  } finally { f.sqlite.close(); }
});

test('refusals name coverage, bounds, lexical code notation and task state; exhausted attempts cannot apply', async () => {
  const cases = [
    { answer: {keep:['decision-a','gotcha-b'],reason:'   '}, error:'reason has 0 non-whitespace (3 raw) characters' },
    { answer: {notes:Array.from({length:CURATION_NEW_NOTES+1},()=>note(['decision-a'])),keep:['gotcha-b']}, error: `notes has ${CURATION_NEW_NOTES+1} entries; limit ${CURATION_NEW_NOTES}` },
    { answer: {keep:['decision-a']}, error:'answer omits 1 members' },
    { answer: {notes:[{...note(['decision-a']),agent_line:'Use capture_spool() to retain data.'}],keep:['gotcha-b']}, error:'contains code notation' },
    { answer: {notes:[{...note(['decision-a']),agent_line:'The retry fix waits on PR #2331, not merged yet.'}],keep:['gotcha-b']}, error:'states the state of a task, "PR #2331, not merged"' },
    { answer: {notes:[{...note(['decision-a']),agent_line:'a'.repeat(AGENT_LINE_MAX_CHARS+5)}],keep:['gotcha-b']}, error:`, 5 more than the ${AGENT_LINE_MAX_CHARS} allowed; shorten that line by at least 5 characters` },
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

test('an admin previews with curation off without changing later discovery, within a separate daily allowance', async () => {
  const f = await fixture();
  try {
    await settingsWriter(f.db).setProjectLeaf('proj_1', 'agent.spore_curation.daily_runs', 1, 'test', f.now);
    await f.add('decision-a'); await f.add('gotcha-b');
    const server = createServer({ now: () => f.now, sourceOf: () => '127.0.0.1', fetchImpl: fetch });
    const serve = (request: Request) => server.handleRequest(request, { ...f.env, secrets: OWNER_ENV });
    const start = () => asOwnerPost(f.db, '/api/harness/dispatch', { task: 'curate-spores', projectId: 'proj_1', dryRun: true }).then(serve);
    const selectionState = () => ['spores', 'resolution_events', 'spore_curation_clock', 'spore_curation_changes',
      'spore_curation_cursor', 'spore_curation_work', 'spore_curation_owners', 'spore_curation_receipts',
      'spore_curation_considerations', 'spore_curation_coverage'].map(table => f.sqlite.query('SELECT * FROM ' + table).all());
    const before = selectionState();
    const admitted = await start(); expect(admitted.status).toBe(200);
    const queued = await admitted.json() as { runId: string };
    const claim = await f.poll(); if (!claim.claimed) throw new Error('off preview not claimed');
    expect(claim.run.id).toBe(queued.runId);
    expect(f.sqlite.query<{ estimate_usd: number }, [string]>('SELECT estimate_usd FROM agent_run_attempts WHERE run_id=?').get(claim.run.id)!.estimate_usd).toBeGreaterThan(0);
    expect(claim.run.profile).toMatchObject({ model: 'sonnet', effort: 'medium' });
    const answer = { ...keepAnswer([]), notes: [note(['decision-a', 'gotcha-b'])] };
    expect(await f.call(claim.run.runToken, 'myco_run_curation', answer)).toMatchObject({ completed: true, applied: false });
    const answerPath = '/api/projects/proj_1/curation/answers/' + claim.run.id;
    const source = (id: string, revision = 0, content = `Whole content for ${id}`) => ({ id, revision: 0, current: { revision, status: 'active', content } });
    const preview = await serve(await asOwner(f.db, answerPath));
    expect(await preview.json()).toMatchObject({ applied: false, checked: { answer: { notes: answer.notes, keep: [], retire: [], reason: answer.reason } },
      sources: [source('decision-a'), source('gotcha-b')] });
    const report = { action: 'preview', summary: 'Curation preview only: no notes changed.', details: JSON.stringify({ notes: answer.notes, keep: [], retire: [], reason: answer.reason }, null, 2) };
    const page = await serve(await asOwner(f.db, '/api/projects/proj_1/runs/' + claim.run.id));
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ run: { dryRun: true }, reports: [report] });
    const member = await issueMemberToken(f.db, { memberId: 'mem_worker', machineId: 'preview-reader' }, f.now);
    expect(await f.call(member.token, 'myco_agent', { op: 'run', id: claim.run.id })).toMatchObject({ ok: true, data: { run: { dry_run: true }, reports: [report] } });
    expect(await endLeasedRun(f.env, { principal: f.principal, now: f.now + 1 }, { ...scope, runId: claim.run.id, attemptId: claim.run.attemptId, status: 'completed' })).toMatchObject({ ended: true, status: 'completed' });
    expect(selectionState()).toEqual(before);
    const limited = await start(); expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: 'daily_limit', perDay: 1 });
    expect(await f.poll()).toMatchObject({ claimed: false });
    await f.enable(); await f.discover();
    const scheduled = await f.poll(); if (!scheduled.claimed) throw new Error('scheduled allowance was consumed by a preview');
    const run = (await getRun(f.db, scope, scheduled.run.id))!;
    expect(curationAssignment(run.runContext)!.members).toEqual(curationAssignment((await getRun(f.db, scope, claim.run.id))!.runContext)!.members);
    expect(run.dryRun).toBe(0);
    f.sqlite.run("UPDATE spores SET content='Edited after the preview.',revision=revision+1 WHERE project_id='proj_1' AND id='gotcha-b'");
    expect(await (await serve(await asOwner(f.db, answerPath))).json()).toMatchObject({ sources: [source('decision-a'), source('gotcha-b', 1, 'Edited after the preview.')] });
    seedMemberRoleAccount(f.sqlite);
    const memberRead = await asOwner(f.db, answerPath); memberRead.headers.set('cookie', await ownerCookie(f.db, f.now, MEMBER_SUB));
    expect((await serve(memberRead)).status).toBe(403);
    expect((await serve(await asOwner(f.db, '/api/projects/proj_1/curation/answers/run_unknown'))).status).toBe(404);
  } finally { f.sqlite.close(); }
});

test('curation off refuses apply and non-admin previews, and an empty preview has a named outcome', async () => {
  const f = await fixture();
  try {
    const server = createServer({ now: () => f.now, sourceOf: () => '127.0.0.1', fetchImpl: fetch });
    const serve = (request: Request) => server.handleRequest(request, { ...f.env, secrets: OWNER_ENV });
    const request = () => asOwnerPost(f.db, '/api/harness/dispatch', { task: 'curate-spores', projectId: 'proj_1', dryRun: true });
    const apply = await serve(await asOwnerPost(f.db, '/api/harness/dispatch', { task: 'curate-spores', projectId: 'proj_1' }));
    expect(apply.status).toBe(409); expect(await apply.json()).toMatchObject({ error: 'capability_off', capability: 'spore_curation' });
    const untouched = await serve(await request());
    expect(await untouched.json()).toMatchObject({ outcome: 'no_qualifying_group', continuation: null });
    seedMemberRoleAccount(f.sqlite);
    const member = await request(); member.headers.set('cookie', await ownerCookie(f.db, f.now, MEMBER_SUB));
    const denied = await serve(member); expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: 'curation_preview_needs_admin' });
    const memberApply = await asOwnerPost(f.db, '/api/harness/dispatch', { task: 'curate-spores', projectId: 'proj_1' });
    memberApply.headers.set('cookie', await ownerCookie(f.db, f.now, MEMBER_SUB));
    expect(await (await serve(memberApply)).json()).toMatchObject({ error: 'curation_hand_start_needs_admin' });
    await f.add('decision-alone'); await f.add('gotcha-pair');
    f.sqlite.run("DELETE FROM spore_curation_changes WHERE project_id='proj_1'");
    const empty = await serve(await request()); expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ outcome: 'no_qualifying_group', message: expect.stringContaining('no preview run was started') });
    expect(await f.poll()).toMatchObject({ claimed: false });
  } finally { f.sqlite.close(); }
});

test('the answer commit and queue insertion refuse member or applied work while curation is off', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('decision-a'); await f.add('gotcha-b'); await f.discover();
    const claim = await f.poll(); if (!claim.claimed) throw new Error('scheduled group not claimed');
    const run = (await getRun(f.db, scope, claim.run.id))!;
    await settingsWriter(f.db).setCapability('proj_1', 'spore_curation', false, 'test', f.now);
    expect(await answerSporeCuration({ ...keepAnswer([]), notes: [note(['decision-a', 'gotcha-b'])] }, {
      db: f.db, projectId: 'proj_1', runId: run.id, agentId: run.agentId, runContext: run.runContext, now: f.now,
    })).toMatchObject({ ok: false, code: 'material_changed' });
    expect((await getSpore(f.db, scope, 'decision-a'))!.status).toBe('active');
    seedMemberRoleAccount(f.sqlite);
    const actor = { memberId: 'mem_machine_2', authority: 'member' as const };
    const spec = { serverUrl: 'https://fixture.test', actor: actor.memberId, options: { dryRun: true } };
    expect(await dispatchTask(f.env, 'curate-spores', 'proj_1', spec, f.now, { actor })).toMatchObject({ dispatched: false, refusal: 'capability_off' });
    const prepared = await prepareDispatch(f.env, 'curate-spores', 'proj_1', { curationPreview: true });
    if (!prepared.ok) throw new Error('preview not prepared');
    await expect(enqueueDispatch(f.env, prepared.prepared, spec, 'worker', f.now, { actor })).rejects.toMatchObject({ refusal: 'capability_off' });
  } finally { f.sqlite.close(); }
});
