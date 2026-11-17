import { searchDeployment } from '@myco-server-worker/core/search.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { expect, test } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { memberHeaders } from './helpers/fixtures.js';
import { budgetFixture } from './helpers/budget-fixture.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { indexFixture } from './helpers/vector-index.js';
import { cloudflareVectorStore } from '@myco-server-worker/platform/cloudflare/vectors.js';
import { vectorId } from '@myco-server-worker/core/embedding/vectors.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { claimNextRun, endLeasedRun, dispatchTask } from '@myco-server-worker/core/harness.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { runToolContext } from '@myco-server-worker/mcp/context.js';
import { curationAssignment, discoverSporeClusters } from '@myco-server-worker/core/spore-curation.js';
import { runCloseRefusal } from '@myco-server-worker/core/run-postconditions.js';
import { type ToolDefinition } from '@myco-server-worker/mcp/definitions.js';
import { CURATION_BODY_CHARS, CURATION_NEW_NOTES } from '@myco-server-worker/core/spore-curation-contract.js';
import { getSpore } from '@myco-server-worker/db/spores/records.js';
import { listSupersedingSporeIds, listSupersededSporeIds } from '@myco-server-worker/db/spores/edges.js';
import { readCurationAnswer, readCurationCoverage } from '@myco-server-worker/db/spores/curation-answer.js';

async function fixture(deferred = false) {
  const f = await budgetFixture();
  const index = indexFixture({deferred:true});
  const vectors = cloudflareVectorStore(index);
  const calls = { get: 0, query: 0, embed: 0 };
  const visits: string[] = [];
  const get = vectors.get.bind(vectors), query = vectors.query.bind(vectors);
  vectors.get = async (...args) => { calls.get++; const found=await get(...args); visits.push(...found.map(row=>row.metadata.record_id)); return found; };
  vectors.query = (...args) => { calls.query++; return query(...args); };
  const env = { ...f.serverEnv, vectors, embeddingProvider: async () => ({ modelKey: 'curation-fixture', embed: async (query: string): Promise<number[]> => { calls.embed++; return query==='other-topic'?[0,1]:[1,0]; } }) };
  const enable = () => settingsWriter(f.db).setCapability('proj_1', 'spore_curation', true, 'test', f.now - 10);
  const add = async (id: string, values = [1, 0], created = f.now, content = `Whole content for ${id}`, stats: {mean:number;std:number}|null = {mean:0.4,std:0.04}) => {
    f.sqlite.run(`INSERT OR IGNORE INTO spores(project_id,id,agent_id,content,observation_type,agent_line,created_at)
      VALUES('proj_1',?,'myco-agent',?,'decision','Use the named seam.',?)`, [id, content, created]);
    const source = f.sqlite.query<{ revision: string }, [string]>("SELECT revision FROM embedding_versions WHERE project_id='proj_1' AND type='spore' AND record_id=?").get(id)!;
    const partition = { projectId: 'proj_1', modelKey: 'curation-fixture' };
    const key = await vectorId(partition, 'spore', id, source.revision);
    await vectors.upsert(partition, [{ id: key, values, metadata: { type: 'spore', record_id: id, revision: source.revision, status: 'active', session_id: '', created_at: created, observation_type: 'decision', release_state: '', release_confidence: '' } }]);
    if(!deferred) index.apply();
    f.sqlite.run(`INSERT OR REPLACE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at,neighbor_mean,neighbor_std)
      VALUES('proj_1','curation-fixture',?,'spore',?,?,1,?,?,?)`, [key, id, source.revision, f.now,stats?.mean??null,stats?.std??null]);
  };
  const discover = async () => { for (let i=0; i<4; i++) await discoverSporeClusters(env, f.now); };
  const poll = (now = f.now) => claimNextRun(env, { principal: f.principal, harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now });
  const ctx = async (runId: string, tokenId: string) => runToolContext(env, { projectId: 'proj_1', run: { ...(await getRun(f.db, { projectId: 'proj_1' }, runId))!, projectId: 'proj_1' }, tokenId, now: f.now, body: '' });
  const server = createServer({ now: () => f.now, sourceOf: () => '127.0.0.1', fetchImpl: fetch });
  const request = async (token: string, method: string, params?: unknown) => {
    const response = await server.handleRequest(new Request('https://fixture.test/mcp', { method: 'POST', headers: memberHeaders(token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), env);
    const body = await response.json() as { error?: unknown; result?: { content?: { text?: string }[]; tools?: ToolDefinition[] } };
    if (body.error !== undefined) throw new Error(JSON.stringify(body.error));
    return body.result;
  };
  const call = async (token: string, name: string, args: Record<string,unknown>) =>
    JSON.parse((await request(token,'tools/call',{name,arguments:{project:'proj_1',...args}}))?.content?.[0]?.text ?? '{}') as unknown;
  const list = async (token: string) => (await request(token,'tools/list'))!.tools!;

  return { ...f, env, enable, add, discover, poll, ctx, call, list, calls, visits, applyVectors:()=>index.apply() };
}

const keepAnswer = (ids: string[]) => ({ op: 'answer', notes: [], keep: ids, retire: [], reason: 'Distinct situations.' });
const note = (sources: string[], content = 'When delivery stalls, retain queued capture.') =>
  ({ sources, observation_type: 'gotcha', agent_line: 'When delivery stalls, retain queued capture.', content });
const scope = {projectId:'proj_1'};

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
    const checked = JSON.parse(stored!.answer!) as { notes: {id:string;createdAt:number}[] };
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
    expect(await readCurationCoverage(f.db,'proj_1')).toBe(0);
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
    expect(refused.error).toContain('Next call: myco_run_curation {"op":"answer"');
    expect(await getSpore(f.db,scope,'decision-a')).toEqual(before);
    expect(await readCurationCoverage(f.db,'proj_1')).toBe(0);
    expect(await f.call(claim.run.runToken,'myco_run_curation',keepAnswer(['decision-a','gotcha-b']))).toMatchObject({completed:true});
    expect(await readCurationCoverage(f.db,'proj_1')).toBe(0);
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
      expect(await f.call(claim.run.runToken,'myco_run_curation',keepAnswer(['decision-a','gotcha-b']))).toMatchObject({ok:false,error:expect.stringContaining('2 of 2')});
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
    expect(await f.call(claim.run.runToken,'myco_run_curation',{...keepAnswer([]),notes:[note(['decision-a','gotcha-b'])]})).toMatchObject({code:'material_changed'});
    expect((await getSpore(f.db,scope,'gotcha-b'))!.status).toBe('active');
    expect((await readCurationAnswer(f.db,'proj_1',claim.run.id))!.answer).toBeNull();
    expect(await readCurationCoverage(f.db,'proj_1')).toBe(1);
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
    expect(await readCurationCoverage(f.db,'proj_1')).toBe(0);
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
    expect(await readCurationCoverage(f.db,'proj_1')).toBe(0);
    await f.add('gotcha-b'); await f.discover(); expect((await f.poll()).claimed).toBe(true);
  }finally{f.sqlite.close();}
});
