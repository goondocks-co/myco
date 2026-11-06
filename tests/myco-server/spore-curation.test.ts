import { sporeCodeAnchors, sporeCurrency, allAnchorsMissing } from '@myco-server-worker/core/spore-currency.js';
import { expect, test } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { memberHeaders, noOutboundFetch } from './helpers/fixtures.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { budgetFixture } from './helpers/budget-fixture.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { indexFixture } from './helpers/vector-index.js';
import { cloudflareVectorStore } from '@myco-server-worker/platform/cloudflare/vectors.js';
import { vectorId } from '@myco-server-worker/core/embedding/vectors.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { claimNextRun, endLeasedRun } from '@myco-server-worker/core/harness.js';
import { getRun } from '@myco-server-worker/core/runs.js';
import { runToolContext } from '@myco-server-worker/mcp/context.js';
import { handleRunCuration } from '@myco-server-worker/mcp/tools/run-curation.js';
import { handleSpores } from '@myco-server-worker/mcp/tools/spores.js';
import { recordReport, runCloseRefusal } from '@myco-server-worker/core/run-postconditions.js';
import { CURATION_STAGE, curationAssignment, discoverSporeClusters, CURATION_SEEDS_PER_TICK } from '@myco-server-worker/core/spore-curation.js';
import { resolveExecutionProfile } from '@myco-server-worker/core/execution-profile.js';
import { seedForStage } from '@myco-server-worker/core/budget-policy.js';

async function fixture(deferred = false) {
  const f = await budgetFixture();
  const index = indexFixture({deferred:true});
  const vectors = cloudflareVectorStore(index);
  const calls = { get: 0, query: 0, embed: 0 };
  const get = vectors.get.bind(vectors), query = vectors.query.bind(vectors);
  vectors.get = (...args) => { calls.get++; return get(...args); };
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
  const poll = (now = f.now) => claimNextRun(env, { principal: f.principal, harnesses: [offeredHarness('claude-code')], now });
  const ctx = async (runId: string, tokenId: string) => runToolContext(env, { projectId: 'proj_1', run: { ...(await getRun(f.db, { projectId: 'proj_1' }, runId))!, projectId: 'proj_1' }, tokenId, now: f.now, body: '' });
  const server = createServer({ now: () => f.now, sourceOf: () => '127.0.0.1', fetchImpl: fetch });
  const call = async (token: string, name: string, args: Record<string, unknown>) => {
    const response = await server.handleRequest(new Request('https://fixture.test/mcp', { method: 'POST', headers: memberHeaders(token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: 'proj_1', ...args } } }) }), env);
    const body = await response.json() as { error?: unknown; result?: { content?: { text?: string }[] } };
    if (body.error !== undefined) throw new Error(JSON.stringify(body.error));
    return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as unknown;
  };
  return { ...f, env, enable, add, discover, poll, ctx, call, calls, applyVectors:()=>index.apply() };
}

for (const activity of ['capture', 'dashboard'] as const) {
  test(`the active wake discovers historical curation groups with runner polling and ${activity}`, async () => {
    const f = await fixture();
    try {
      expect(await f.enable()).toMatchObject({ applied: true });
      expect(await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled', true, 'test', f.now)).toMatchObject({ applied: true });
      expect(await settingsWriter(f.db).setCapability('proj_1', 'spore_curation_backfill', true, 'test', f.now)).toMatchObject({ applied: true });
      for (const id of ['a', 'b', 'c', 'd', 'e']) await f.add(id, [1, 0], 1);
      const minted = await issueMemberToken(f.db, { memberId: 'mem_worker', machineId: 'polling-runner' }, f.now);
      f.sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        VALUES('proj_1','busy-session','polling-runner',?,?,?)`, [minted.tokenId, f.now, f.now]);
      let now = f.now;
      const server = createServer({ now: () => now, sourceOf: () => '192.0.2.1', fetchImpl: noOutboundFetch });
      for (now = f.now; now <= f.now + 6 * 60_000; now += 2_000) {
        if (activity === 'capture' && (now - f.now) % 60_000 === 0) {
          f.sqlite.run("UPDATE sessions SET last_received_at=? WHERE project_id='proj_1' AND session_id='busy-session'", [now]);
        }
        if (activity === 'dashboard' && (now - f.now) % 60_000 === 0) {
          const cookie = await ownerCookie(f.db, now);
          const response = await server.handleRequest(new Request('https://fixture.test/api/projects', { headers: { cookie } }), { ...f.env, secrets: OWNER_ENV });
          expect(response.status).toBe(200);
        }
        const response = await server.handleRequest(new Request('https://fixture.test/worker/claim', {
          method: 'POST', headers: memberHeaders(minted.token), body: JSON.stringify({ harnesses: [offeredHarness('claude-code')] }),
        }), f.env);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ persisted: true, claimed: false, reason: 'no_work' });
      }
      const tick = await runTick(f.env, now - 2_000, { serverUrl: 'https://fixture.test', wake: 'clock' });
      expect(tick.state).toBe('active');
      expect(tick.jobs.find(job => job.name === 'spore-curation')).toMatchObject({ changed: 1, failed: null });
      const groups = f.sqlite.query<{ members: string }, []>("SELECT members FROM spore_curation_work WHERE project_id='proj_1' AND decision IS NULL").all();
      expect(groups).toHaveLength(1);
      expect(JSON.parse(groups[0]!.members).map((member: { id: string }) => member.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(f.calls.get).toBeLessThanOrEqual(CURATION_SEEDS_PER_TICK);
      expect(f.calls.embed).toBe(0);
    } finally { f.sqlite.close(); }
  });
}

test('off by default; no overlap creates no work or run; historical seeds require separate opt-in', async () => {
  const f = await fixture();
  try {
    expect(await settingsWriter(f.db).capabilityEnabled('proj_1', 'spore_curation')).toBe(false);
    await f.add('a', [1,0], 1); await f.add('b', [0,1], 1);
    await f.discover(); expect(await f.poll()).toMatchObject({ claimed: false });
    await f.enable(); await f.discover(); expect(await f.poll()).toMatchObject({ claimed: false });
    expect(f.sqlite.query('SELECT COUNT(*) AS n FROM spore_curation_work').get()).toEqual({ n: 0 });
    await settingsWriter(f.db).setCapability('proj_1', 'spore_curation_backfill', true, 'test', f.now);
    await f.discover(); expect(await f.poll()).toMatchObject({ claimed: false });
    expect(f.sqlite.query('SELECT COUNT(*) AS n FROM agent_runs').get()).toEqual({ n: 0 });
    expect(f.sqlite.query('SELECT after_at FROM spore_curation_cursor').get()).not.toBeNull();
  } finally { f.sqlite.close(); }
});

test('a real claim receives whole spores on Sonnet low; kept-apart revisions stay settled until a member changes', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b'); await f.add('c'); await f.add('d'); await f.add('e'); await f.discover();
    const claimed = await f.poll(); expect(claimed.claimed).toBe(true); if (!claimed.claimed) return;
    expect(claimed.run.profile).toMatchObject({ model: 'sonnet', effort: 'low' });
    expect(claimed.run.instruction).toContain('Whole content for a');
    expect(claimed.run.instruction).toContain('Whole content for b');
    expect(claimed.run).not.toHaveProperty('repository');
    const ctx = await f.ctx(claimed.run.id, claimed.run.attemptId);
    expect(curationAssignment(ctx.principal.kind === 'run' ? ctx.principal.runContext : null)?.members).toHaveLength(5);
    expect(await handleRunCuration({ op: 'complete', decision: 'resolved', reason: 'I claim I did it' }, ctx)).toMatchObject({ ok: false });
    expect(await f.call(claimed.run.runToken, 'myco_run_curation', { op: 'complete', decision: 'keep', members: ['a','b','c','d','e'].map(id=>({id,revision:0})), reason: 'The two seams apply to distinct actors.' })).toEqual({ completed: true });
    await recordReport(ctx.env.db, { projectId: 'proj_1' }, { runId: claimed.run.id, agentId: 'myco-agent', action: 'curated', summary: 'Kept distinct applicability', details: null, audit: null, createdAt: f.now });
    expect(await runCloseRefusal(f.db, { projectId: 'proj_1' }, (await getRun(f.db, { projectId: 'proj_1' }, claimed.run.id))!)).toBeNull();
    await endLeasedRun(f.env, { principal: f.principal, now: f.now+1 }, { projectId: 'proj_1', runId: claimed.run.id, attemptId: claimed.run.attemptId, status: 'completed' });
    await f.discover(); expect(await f.poll()).toMatchObject({ claimed: false });
    expect(f.sqlite.query('SELECT COUNT(*) AS n FROM spore_curation_work').get()).toEqual({ n: 1 });
    f.sqlite.run("UPDATE spores SET content='New content',revision=revision+1,updated_at=? WHERE id='a'", [f.now+1]);
    await f.add('a'); await f.discover();
    expect((await f.poll()).claimed).toBe(true);
    expect(f.sqlite.query('SELECT COUNT(*) AS n FROM spore_curation_work').get()).toEqual({ n: 2 });
  } finally { f.sqlite.close(); }
});

test('stale decisions and lifecycle writes refuse concurrent edits; own resolution preserves lineage and close evidence', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b'); await f.discover();
    const claimed = await f.poll(); expect(claimed.claimed).toBe(true); if (!claimed.claimed) return;
    const ctx = await f.ctx(claimed.run.id, claimed.run.attemptId);
    const assignment = curationAssignment(ctx.principal.kind === 'run' ? ctx.principal.runContext : null)!;
    f.sqlite.run("UPDATE spores SET content='Concurrent edit',revision=revision+1,updated_at=? WHERE id='a'", [f.now+1]);
    expect(await handleRunCuration({ op: 'complete', decision: 'keep', members: assignment.members, reason: 'Keep' }, ctx)).toMatchObject({ code: 'material_changed' });
    expect(await handleSpores({ op: 'supersede', old_spore_id: 'a', new_spore_id: 'b', expect_revision: assignment.members[0]!.revision, expect_status:'active', reason: 'b covers a' }, ctx)).toMatchObject({ ok: false });
    expect(f.sqlite.query("SELECT content,status FROM spores WHERE id='a'").get()).toEqual({ content: 'Concurrent edit', status: 'active' });
    expect(await handleSpores({ op: 'supersede', old_spore_id: 'b', new_spore_id: 'a', expect_revision: 999, expect_status:'active', reason: 'a covers b' }, ctx)).toMatchObject({ ok: false });
  } finally { f.sqlite.close(); }
  const g = await fixture();
  try {
    await g.enable(); await g.add('a'); await g.add('b'); await g.discover();
    const claimed = await g.poll(); expect(claimed.claimed).toBe(true); if (!claimed.claimed) return;
    const ctx = await g.ctx(claimed.run.id, claimed.run.attemptId);
    const assignment = curationAssignment(ctx.principal.kind === 'run' ? ctx.principal.runContext : null)!;
    expect(await handleSpores({ op: 'supersede', old_spore_id: 'a', new_spore_id: 'b', expect_revision: assignment.members[0]!.revision, expect_status: 'active', reason: 'b covers the same guidance completely' }, ctx)).toMatchObject({ status: 'superseded' });
    expect(await handleRunCuration({ op: 'complete', decision: 'resolved', reason: 'Retired duplicated guidance; b retains it.' }, ctx)).toEqual({ completed: true });
    expect(g.sqlite.query('SELECT spore_id,new_spore_id,author FROM resolution_events').get()).toEqual({ spore_id: 'a', new_spore_id: 'b', author: claimed.run.id });
    expect(g.sqlite.query('SELECT COUNT(*) AS n FROM spores').get()).toEqual({ n: 2 });
  } finally { g.sqlite.close(); }
});

test('daily ceiling, rolling budget reserve and failed-cluster backoff refuse dispatch', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b'); await f.discover();
    await settingsWriter(f.db).setProjectLeaf('proj_1','agent.spore_curation.daily_runs',2,'test',f.now);
    await f.setting(1); f.history('other-spend', 0.5);
    expect(await f.poll()).toMatchObject({ claimed: false });
    await f.setting(20);
    const claimed = await f.poll(); expect(claimed.claimed).toBe(true); if (!claimed.claimed) return;
    await endLeasedRun(f.env, { principal: f.principal, now: f.now+1 }, { projectId: 'proj_1', runId: claimed.run.id, attemptId: claimed.run.attemptId, status: 'failed', error: 'fixture failure' });
    expect(await f.poll(f.now+2)).toMatchObject({ claimed: false });
    f.sqlite.run("UPDATE spore_curation_work SET due_at=?", [f.now]);
    const second = await f.poll(f.now+3); expect(second.claimed).toBe(true); if (!second.claimed) return;
    await endLeasedRun(f.env, { principal: f.principal, now: f.now+4 }, { projectId: 'proj_1', runId: second.run.id, attemptId: second.run.attemptId, status: 'failed', error: 'fixture failure' });
    f.sqlite.run("UPDATE spore_curation_work SET due_at=?", [f.now]);
    expect(await f.poll(f.now+5)).toMatchObject({ claimed: false });
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_runs WHERE task='curate-spores'").get()).toEqual({ n: 2 });
    expect(seedForStage('curate-spores')).toBe(0.25);
    expect(CURATION_STAGE.level).toBeGreaterThan(4);
  } finally { f.sqlite.close(); }
});

test('the D1 gate seeks bounded indexed pages and resumes within a large active corpus', async () => {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const { SCHEMA_STEPS } = await import('@myco-server-worker/db/schema.js');
  const { measuredStore } = await import('./helpers/read-budget.js');
  const f = await fixture();
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map(sql => d1.prepare(sql)));
    const meter = measuredStore(d1);
    const env = { ...f.env, db: meter.db };
    await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','p',1)").run();
    await d1.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','Agent','built-in',1,1)").run();
    await settingsWriter(meter.db).setCapability('proj_1', 'spore_curation', true, 'test', 1);
    const reads: number[] = [];
    for (const size of [2_000, 20_000]) {
      await d1.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
        INSERT OR IGNORE INTO spores(project_id,id,agent_id,content,observation_type,created_at)
        SELECT 'proj_1',printf('s-%06d',x),'agent','body','decision',2 FROM n`).bind(size).run();
      await d1.prepare(`INSERT INTO spore_curation_cursor(project_id,after_at,after_id,active,pass_revision) VALUES('proj_1',2,?,1,(SELECT revision FROM spore_curation_changes WHERE project_id='proj_1')) ON CONFLICT(project_id) DO UPDATE SET after_at=2,after_id=excluded.after_id,active=1,pass_revision=excluded.pass_revision`).bind(`s-${String(size-10).padStart(6,'0')}`).run();
      meter.reset(); await discoverSporeClusters(env, f.now); reads.push(meter.reads());
    }
    expect(reads[1]).toBeLessThanOrEqual(reads[0]! + 10);
    expect(reads[1]).toBeLessThan(200);
    expect(await d1.prepare('SELECT after_id FROM spore_curation_cursor').first()).toEqual({ after_id: `s-${String(20_000-10+CURATION_SEEDS_PER_TICK).padStart(6,'0')}` });
  } finally { await mf.dispose(); f.sqlite.close(); }
});

test('curation uses a fixed supported Sonnet low profile with no repository requirement', () => {
  const offered = offeredHarness('claude-code');
  expect(resolveExecutionProfile('curate-spores', offered.id, offered.profile, new Map([
    ['agent.reasoning_map.claude-code.low', '"opus"'], ['agent.effort_map.claude-code.low', '"max"'],
  ]))).toMatchObject({ profile: { tier: 'low', model: 'sonnet', effort: 'low' } });
  expect(resolveExecutionProfile('curate-spores', 'codex', offered.profile, new Map())).toHaveProperty('reason');
});

test('six shared semantic searches admit whole members; one grown group consolidates with complete lineage', async () => {
  const f=await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b'); await f.add('c',[0.7,0.7]); await f.discover();
    expect(f.calls.embed).toBe(0);
    const claim=await f.poll(); expect(claim.claimed).toBe(true); if(!claim.claimed) return;
    const token=claim.run.runToken, ctx=await f.ctx(claim.run.id,claim.run.attemptId);
    expect(await f.call(token,'myco_run_curation',{op:'material',id:'c'})).toMatchObject({ok:false});
    f.sqlite.run("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES('proj_1','outside','myco-agent','Outside search','decision',?)",[f.now]);
    for(let i=0;i<6;i++) expect(await f.call(token,'myco_search',{query:'seam',mode:'fts',type:'session',limit:100})).toMatchObject({results:expect.arrayContaining([{id:'c',revision:0,type:'decision',agent_line:'Use the named seam.'}]),searches_remaining:5-i});
    expect(await f.call(token,'myco_search',{query:'seam'})).toMatchObject({ok:false,error:expect.stringContaining('budget')});
    expect(f.calls.embed).toBe(6);
    expect(await f.call(token,'myco_run_curation',{op:'material',id:'outside'})).toMatchObject({ok:false});
    expect(await handleSpores({op:'supersede',old_spore_id:'outside',new_spore_id:'a',expect_revision:0,expect_status:'active',reason:'outside'},ctx)).toMatchObject({ok:false});
    expect(await f.call(token,'myco_run_curation',{op:'material',id:'c'})).toMatchObject({spore:{id:'c',content:'Whole content for c'},read:expect.arrayContaining([{id:'c',revision:0}])});
    expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_owners').get()).toEqual({n:2});
    const sources=['a','b','c'].map(id=>({id,revision:0}));
    expect(await f.call(token,'myco_spores',{op:'consolidate',source_spore_ids:sources,observation_type:'wisdom',consolidated_content:'a, b and c: preserve the named seam and every detail.',agent_line:'Use the named seam.',reason:'One topic, complementary details.'})).toMatchObject({status:'consolidated',sources_consolidated:3});
    expect(await f.call(token,'myco_run_curation',{op:'material',id:'outside'})).toMatchObject({ok:false});
    expect(await f.call(token,'myco_spores',{op:'consolidate',source_spore_ids:sources,observation_type:'wisdom',consolidated_content:'Again',agent_line:'Again',reason:'Again'})).toMatchObject({ok:false});
    expect(await f.call(token,'myco_run_curation',{op:'complete',decision:'resolved',reason:'Combined three complementary sources into one wisdom.'})).toEqual({completed:true});
    expect(f.sqlite.query('SELECT COUNT(*) n FROM resolution_events WHERE author=?').get(claim.run.id)).toEqual({n:3});
    expect(f.sqlite.query("SELECT COUNT(*) n FROM spores WHERE status='active' AND observation_type='wisdom'").get()).toEqual({n:1});
    expect(f.sqlite.query('SELECT COUNT(*) n FROM agent_runs').get()).toEqual({n:1});
  } finally { f.sqlite.close(); }
});

test('keep receipts cover search-only additions and one changed addition reopens only one group', async () => {
  const f=await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b'); await f.add('c',[0.7,0.7]); await f.add('d',[0.7,0.7]); await f.discover();
    const claim=await f.poll(); expect(claim.claimed).toBe(true); if(!claim.claimed) return;
    const call=(name:string,args:Record<string,unknown>)=>f.call(claim.run.runToken,name,args);
    await call('myco_search',{query:'seams'});
    for(const id of ['c','d']) expect(await call('myco_run_curation',{op:'material',id})).toMatchObject({spore:{id}});
    expect(await call('myco_run_curation',{op:'complete',decision:'keep',members:['a','b','c','d'].map(id=>({id,revision:0})),reason:'Four distinct contexts share a topic.'})).toEqual({completed:true});
    expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_receipts').get()).toEqual({n:4});
    await recordReport(f.db,{projectId:'proj_1'},{runId:claim.run.id,agentId:'myco-agent',action:'curated',summary:'Kept four distinct contexts',details:null,audit:null,createdAt:f.now});
    await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{projectId:'proj_1',runId:claim.run.id,attemptId:claim.run.attemptId,status:'completed'});
    await f.discover(); expect(await f.poll()).toMatchObject({claimed:false});
    f.sqlite.run("UPDATE spores SET revision=revision+1,updated_at=? WHERE id='c'",[f.now+1]); await f.add('c',[0.7,0.7]);
    await f.discover(); expect((await f.poll()).claimed).toBe(true);
    expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_work').get()).toEqual({n:2});
  } finally { f.sqlite.close(); }
});

test('ready session learning is claimed before curation, and an observed price still leaves learning room', async () => {
  const { installPulledStages } = await import('@myco-server-worker/core/pulled-stages.js');
  const { PULL_FIXTURE_TABLE, testPulledStage } = await import('../helpers/pulled-test-stage.js');
  const { estimateKey } = await import('@myco-server-worker/core/budget-estimates.js');
  const { mutateState } = await import('@myco-server-worker/core/runs.js');
  const f = await fixture();
  let restore = () => {};
  try {
    await f.enable(); await f.add('a'); await f.add('b'); await f.discover();
    await settingsWriter(f.db).setProjectLeaf('proj_1','agent.spore_curation.daily_runs',2,'test',f.now);
    await f.setting(1);
    const key = estimateKey('curate-spores', 'claude-code', { tier: 'low', model: 'sonnet' });
    await mutateState(f.db, { projectId: 'proj_1' }, 'myco-agent', key, () => JSON.stringify({ estimate: 0.8 }), f.now);
    expect(await f.poll()).toMatchObject({ claimed: false });
    await mutateState(f.db, { projectId: 'proj_1' }, 'myco-agent', key, () => JSON.stringify({ estimate: 0.05 }), f.now);
    f.sqlite.exec(PULL_FIXTURE_TABLE);
    f.sqlite.run("INSERT INTO pull_fixture_items VALUES('proj_1','learning',1,'extract-curate',?)", [f.now]);
    restore = installPulledStages([testPulledStage(1, 'extract-curate'), CURATION_STAGE]);
    const claimed = await f.poll(); expect(claimed.claimed).toBe(true);
    if (claimed.claimed) expect(claimed.run.task).toBe('extract-curate');
  } finally { restore(); f.sqlite.close(); }
});

test('three failed attempts close a poison cluster and release discovery for a separate overlap', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b'); await f.discover();
    await f.add('c',[0,1]); await f.add('d',[0,1]);
    for (let attempt=0; attempt<3; attempt++) {
      const now=f.now+attempt*8*3_600_000, claimed=await f.poll(now);
      expect(claimed.claimed).toBe(true); if (!claimed.claimed) return;
      await endLeasedRun(f.env,{principal:f.principal,now:now+1},{projectId:'proj_1',runId:claimed.run.id,attemptId:claimed.run.attemptId,status:'failed',error:'fixture failure'});
    }
    await discoverSporeClusters(f.env,f.now+16*3_600_000+2);
    expect(f.sqlite.query("SELECT failures,reason FROM spore_curation_work WHERE decision='failed'").get()).toEqual({failures:3,reason:'Curation stopped after 3 attempts without a decision'});
    const next=f.sqlite.query<{members:string},[]>("SELECT members FROM spore_curation_work WHERE decision IS NULL").get()!;
    expect(JSON.parse(next.members).map((m:{id:string})=>m.id).sort()).toEqual(['c','d']);
    expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_owners').get()).toEqual({n:2});
  } finally {f.sqlite.close();}
});

test('a completed no-overlap pass rests with zero vector calls and writes; late vector readiness restarts it', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b');
    f.sqlite.run("DELETE FROM embedding_receipts WHERE record_id='b'");
    await f.discover();
    expect(f.sqlite.query('SELECT dirty FROM spore_curation_changes').get()).toEqual({dirty:0});
    const before={...f.calls}, mark=f.executed.length;
    await f.discover(); await f.discover();
    expect(f.calls).toEqual(before);
    expect(f.executed.slice(mark).filter(sql=>/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toEqual([]);
    await f.add('b'); await f.discover();
    expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_work').get()).toEqual({n:1});
  } finally {f.sqlite.close();}
});

test('a capped cluster keeps exclusive open ownership and later unreviewed neighbours remain discoverable', async () => {
  const f = await fixture();
  try {
    await f.enable(); for(let i=0;i<16;i++) await f.add(`s${String(i).padStart(2,'0')}`);
    await f.discover();
    expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_owners').get()).toEqual({n:8});
    expect(()=>f.sqlite.run("INSERT INTO spore_curation_owners SELECT project_id,spore_id,'other' FROM spore_curation_owners LIMIT 1")).toThrow();
    const claimed=await f.poll(); expect(claimed.claimed).toBe(true); if(!claimed.claimed)return;
    const ctx=await f.ctx(claimed.run.id,claimed.run.attemptId);
    for(let i=0;i<5;i++) await f.add(`search-${i}`,[0,1],f.now+1);
    await f.call(claimed.run.runToken,'myco_search',{query:'other-topic'});
    for(let i=0;i<4;i++) expect(await f.call(claimed.run.runToken,'myco_run_curation',{op:'material',id:`search-${i}`})).toHaveProperty('spore');
    expect(await f.call(claimed.run.runToken,'myco_run_curation',{op:'material',id:'search-4'})).toMatchObject({ok:false,error:expect.stringContaining('cap')});
    expect(await handleRunCuration({op:'complete',decision:'keep',members:curationAssignment(ctx.principal.kind==='run'?ctx.principal.runContext:null)!.members,reason:'Distinct applicability'},ctx)).toEqual({completed:true});
    await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{projectId:'proj_1',runId:claimed.run.id,attemptId:claimed.run.attemptId,status:'failed',error:'fixture failure after decision'});
    await f.discover();
    const next=f.sqlite.query<{members:string},[]>("SELECT members FROM spore_curation_work WHERE decision IS NULL").get()!;
    const original=curationAssignment(ctx.principal.kind==='run'?ctx.principal.runContext:null)!.members.map(member=>member.id);
    expect(JSON.parse(next.members)).toHaveLength(8);
    expect(JSON.parse(next.members).filter((member:{id:string})=>!original.includes(member.id)).length).toBe(8);
  } finally {f.sqlite.close();}
});

test('supersession rejects self, retired and outside targets and cannot create an a-b cycle', async () => {
  const f=await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b'); await f.add('outside',[0,1]); await f.discover();
    const claimed=await f.poll(); expect(claimed.claimed).toBe(true); if(!claimed.claimed)return;
    const ctx=await f.ctx(claimed.run.id,claimed.run.attemptId);
    const move=(a:string,b:string)=>handleSpores({op:'supersede',old_spore_id:a,new_spore_id:b,expect_revision:0,expect_status:'active',reason:'duplicate'},ctx);
    expect(await move('a','a')).toMatchObject({ok:false});
    expect(await move('a','outside')).toMatchObject({ok:false});
    expect(await move('a','b')).toMatchObject({status:'superseded'});
    expect(await move('b','a')).toMatchObject({ok:false});
    expect(f.sqlite.query("SELECT id FROM spores WHERE status='active' AND id IN ('a','b')").all()).toEqual([{id:'b'}]);
  } finally {f.sqlite.close();}
});

test('the Project integer setting defaults to five and its admitted writer preserves scope, actor and rearm', async () => {
  const f=await fixture(), rearmed:string[]=[];
  try {
    const {curationDailyLimit}=await import('@myco-server-worker/core/settings.js');
    const writer=settingsWriter(f.db,{rearm:async({leaf})=>{rearmed.push(leaf);}});
    expect(await curationDailyLimit(f.db,'proj_1')).toBe(5);
    for(const value of [0,1.5,1001]) expect((await writer.setProjectLeaf('proj_1','agent.spore_curation.daily_runs',value,'test',f.now)).applied).toBe(false);
    expect((await writer.setProjectLeaf('proj_1','agent.spore_curation.daily_runs',20,'test',f.now)).applied).toBe(true);
    expect(await curationDailyLimit(f.db,'proj_1')).toBe(20); expect(await curationDailyLimit(f.db,'proj_2')).toBe(5);
    expect(f.sqlite.query('SELECT updated_by FROM project_settings').get()).toEqual({updated_by:'test'});
    expect(rearmed).toEqual(['agent.spore_curation.daily_runs']);
  } finally {f.sqlite.close();}
});

test('whole reads leave off-topic hits out and a three-seed group can resolve only its two duplicates', async () => {
  for (const seeded of [false,true]) {
    const f=await fixture();
    try {
      await f.enable(); for (const id of ['a','b']) await f.add(id); await f.add('c',seeded?[1,0]:[0.7,0.7]); await f.discover();
      const claim=await f.poll(); expect(claim.claimed).toBe(true); if(!claim.claimed)return;
      const call=(name:string,args:Record<string,unknown>)=>f.call(claim.run.runToken,name,args);
      if(!seeded) { await call('myco_search',{query:'seam'}); expect(await call('myco_run_curation',{op:'material',id:'c'})).toMatchObject({spore:{id:'c'}}); }
      expect(await call('myco_spores',{op:'supersede',old_spore_id:'a',new_spore_id:'b',expect_revision:0,expect_status:'active',reason:'b fully covers a'})).toMatchObject({status:'superseded'});
      expect(await call('myco_run_curation',{op:'complete',decision:'resolved',reason:'b covers a; c is off-topic and undecided.'})).toEqual({completed:true});
      expect(f.sqlite.query('SELECT spore_id FROM spore_curation_receipts ORDER BY spore_id').all()).toEqual([{spore_id:'a'},{spore_id:'b'}]);
      const row=f.sqlite.query<{members:string;final_members:string},[]>('SELECT members,final_members FROM spore_curation_work').get()!;
      expect(JSON.parse(row.final_members).map((m:{id:string})=>m.id)).toEqual(['a','b']); expect(JSON.parse(row.members)).toHaveLength(seeded?3:2);
      expect(f.sqlite.query("SELECT status FROM spores WHERE id='c'").get()).toEqual({status:'active'});
      await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{projectId:'proj_1',runId:claim.run.id,attemptId:claim.run.attemptId,status:'failed',error:'fixture ended'});
      await f.discover(); if(!seeded) expect(await f.poll()).toMatchObject({claimed:false});
      await f.add('later',seeded?[1,0]:[0.7,0.7],f.now+1); await f.discover();
      expect(f.sqlite.query<{members:string},[]>("SELECT members FROM spore_curation_work WHERE decision IS NULL ORDER BY due_at DESC LIMIT 1").get()!.members).toContain('"c"');
    } finally {f.sqlite.close();}
  }
});

test('a closed seed outcome deduplicates its original set without acknowledging excluded seeds', async () => {
  const f=await fixture();
  try {
    await f.enable(); for(const id of ['a','b','c']) await f.add(id); await f.discover();
    const claim=await f.poll(); expect(claim.claimed).toBe(true); if(!claim.claimed)return;
    expect(await f.call(claim.run.runToken,'myco_run_curation',{op:'complete',decision:'keep',members:['a','b'].map(id=>({id,revision:0})),reason:'a and b stand apart; c remains undecided.'})).toEqual({completed:true});
    await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{projectId:'proj_1',runId:claim.run.id,attemptId:claim.run.attemptId,status:'failed',error:'fixture ended'});
    await f.discover(); expect(await f.poll()).toMatchObject({claimed:false});
    expect(f.sqlite.query("SELECT 1 FROM spore_curation_receipts WHERE spore_id='c'").get()).toBeNull();
    await f.add('later',[1,0],f.now+1); await f.discover(); expect((await f.poll()).claimed).toBe(true);
  } finally {f.sqlite.close();}
});

test('one new spore restarts at its changed stamp with one vector query', async () => {
  const f=await fixture();
  try {
    await f.enable(); for(let i=0;i<64;i++) await f.add(`s${i}`,[1,i+10]);
    const query=f.env.vectors.query.bind(f.env.vectors);
    f.env.vectors.query=(...args)=>args[1].values[1]===0?query(...args):(f.calls.query++,Promise.resolve([]));
    for(let i=0;i<12;i++) await discoverSporeClusters(f.env,f.now);
    const prior={...f.calls}; await f.add('new',[1,0],f.now+1); await f.discover();
    expect(f.calls.query-prior.query).toBe(1); expect(f.calls.get-prior.get).toBe(1);
    expect(f.sqlite.query('SELECT dirty FROM spore_curation_changes').get()).toEqual({dirty:0});
  } finally {f.sqlite.close();}
});

test('a changed close releases every seed with no review receipt and discovers the unchanged overlap', async () => {
  const f=await fixture();
  try {
    await f.enable(); for(const id of ['a','b','c']) await f.add(id); await f.discover();
    f.sqlite.run("UPDATE spores SET revision=revision+1,updated_at=? WHERE id='a'",[f.now+1]); await f.add('a',[0,1]);
    expect(await f.poll()).toMatchObject({claimed:false});
    expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_receipts').get()).toEqual({n:0});
    expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_owners').get()).toEqual({n:0});
    await f.discover(); const claim=await f.poll(); expect(claim.claimed).toBe(true); if(!claim.claimed)return;
    expect(claim.run.instruction).toContain('Whole content for b'); expect(claim.run.instruction).toContain('Whole content for c');
  } finally {f.sqlite.close();}
});

test('material owned by another open group is terminal for that candidate and does not consume a read', async () => {
  const f=await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b'); await f.add('c',[0.7,0.7]); await f.discover();
    const claim=await f.poll(); expect(claim.claimed).toBe(true); if(!claim.claimed)return;
    await f.call(claim.run.runToken,'myco_search',{query:'seam'});
    f.sqlite.run("INSERT INTO spore_curation_work(project_id,cluster_key,members,due_at) VALUES('proj_1','other','[]',?)",[f.now]);
    f.sqlite.run("INSERT INTO spore_curation_owners VALUES('proj_1','c','other')");
    expect(await f.call(claim.run.runToken,'myco_run_curation',{op:'material',id:'c'})).toMatchObject({available:false,code:'curation_owned'});
    expect(f.sqlite.query("SELECT read FROM spore_curation_candidates WHERE spore_id='c'").get()).toEqual({read:0});
    expect(await f.call(claim.run.runToken,'myco_run_curation',{op:'complete',decision:'keep',members:['a','b'].map(id=>({id,revision:0})),reason:'Distinct seeds; c belongs elsewhere.'})).toEqual({completed:true});
  } finally {f.sqlite.close();}
});

test('a D1 budget-band poll reads at most idle plus 2.1 rows per attempt without building or retrying', async () => {
  const {Miniflare,convertV4MiniflareOptions}=await import('miniflare');
  const {SCHEMA_STEPS}=await import('@myco-server-worker/db/schema.js');
  const {measuredStore}=await import('./helpers/read-budget.js');
  const {ensureMember}=await import('@myco-server-worker/auth/enrollment.js');
  const {issueMemberToken}=await import('@myco-server-worker/auth/tokens.js');
  const {legacyWorker}=await import('./helpers/worker-principal.js');
  const {completeBudgetMigration}=await import('@myco-server-worker/db/budget-activation.js');
  const {estimateKey}=await import('@myco-server-worker/core/budget-estimates.js');
  const {mutateState}=await import('@myco-server-worker/core/runs.js');
  const f=await fixture(), attempts=300;
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default { fetch() { return new Response(null); } }',compatibilityDate:'2026-07-01',d1Databases:['DB']}));
  try {
    const d1=await mf.getD1Database('DB');
    for(const step of SCHEMA_STEPS) await d1.batch(step.statements.map(sql=>d1.prepare(sql)));
    await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','p',1)").run();
    await d1.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Agent','built-in',1,1)").run();
    const meter=measuredStore(d1), env={...f.env,db:meter.db};
    await ensureMember(meter.db,'mem_harness',f.now,'member'); await ensureMember(meter.db,'mem_worker',f.now,'admin');
    const worker=await issueMemberToken(meter.db,{memberId:'mem_worker',machineId:'budget-machine'},f.now);
    const principal=legacyWorker(worker.tokenId,'budget-machine');
    await completeBudgetMigration(meter.db,f.now);
    await settingsWriter(meter.db).setCapability('proj_1','spore_curation',true,'test',f.now-10);
    for(let start=0;start<attempts;start+=100) await d1.batch(Array.from({length:100},(_,offset)=>{
      const id=`history-${start+offset}`;
      return [
        d1.prepare("INSERT INTO member_credentials(id,member_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at) VALUES(?,'mem_harness',?,?,?,?,?)").bind(id,`fixture-${id}`,f.now,f.now+3600000,id,f.now),
        d1.prepare("INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,dispatched_by,cost_usd,origin) VALUES('proj_1',?,'myco-agent','turn-cards','completed',?,?,?,0.01,'automatic')").bind(id,f.now-1,f.now,id),
        d1.prepare("INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,estimate_usd,cost_usd) VALUES('proj_1',?,?,?,?,0.01,0.01)").bind(id,id,worker.tokenId,f.now-1),
      ];
    }).flat());
    await settingsWriter(meter.db).setLeaf('agent.budget.daily_usd',attempts*0.01+0.8,'mem_worker',f.now);
    const key=estimateKey('curate-spores','claude-code',{tier:'low',model:'sonnet'});
    await mutateState(meter.db,{projectId:'proj_1'},'myco-agent',key,()=>JSON.stringify({estimate:0.35}),f.now);
    const poll=()=>claimNextRun(env,{principal,harnesses:[offeredHarness('claude-code')],now:f.now});
    meter.reset(); expect(await poll()).toMatchObject({claimed:false}); const idle=meter.reads();
    await d1.prepare("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES('proj_1','a','myco-agent','A','decision',1),('proj_1','b','myco-agent','B','decision',1)").run();
    await d1.prepare("INSERT INTO spore_curation_work(project_id,cluster_key,members,due_at) VALUES('proj_1','band',?,?)").bind(JSON.stringify(['a','b'].map(id=>({id,revision:0}))),f.now).run();
    for(let i=0;i<2;i++) {
      meter.reset(); expect(await poll()).toMatchObject({claimed:false});
      expect(meter.reads()).toBeLessThanOrEqual(idle+Math.ceil(2.1*attempts)); expect(meter.writes()).toBe(0);
    }
  } finally {await mf.dispose();f.sqlite.close();}
});

test('ready vectors still applying retry at their source stamp and stop at the lost-vector limit',async()=>{
  const {VECTOR_LOST_MS}=await import('@myco-server-worker/core/embedding/provider.js');
  const f=await fixture(true);
  try {
    await f.enable(); await f.add('old'); f.applyVectors(); await f.discover();
    await f.add('new',[1,0],f.now+1);
    await discoverSporeClusters(f.env,f.now+1);
    expect(f.sqlite.query('SELECT dirty,pending_at FROM spore_curation_changes').get()).toEqual({dirty:1,pending_at:f.now+1});
    expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_work').get()).toEqual({n:0});
    f.applyVectors(); await discoverSporeClusters(f.env,f.now+60_000);
    expect(f.sqlite.query<{members:string},[]>('SELECT members FROM spore_curation_work').get()!.members).toContain('"new"');
  }finally{f.sqlite.close();}
  const g=await fixture(true);
  try {
    await g.enable(); await g.add('lost'); await discoverSporeClusters(g.env,g.now);
    expect(g.sqlite.query('SELECT dirty FROM spore_curation_changes').get()).toEqual({dirty:1});
    await discoverSporeClusters(g.env,g.now+VECTOR_LOST_MS);
    expect(g.sqlite.query('SELECT dirty FROM spore_curation_changes').get()).toEqual({dirty:0});
    const before={...g.calls}; await discoverSporeClusters(g.env,g.now+VECTOR_LOST_MS+60_000);
    expect(g.calls).toEqual(before);
  }finally{g.sqlite.close();}

});

test('a failed run that resolved only searched hits closes changed before another model attempt',async()=>{
  const f=await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b'); for(const id of ['h1','h2']) await f.add(id,[0.7,0.7]); await f.discover();
    const claim=await f.poll(); expect(claim.claimed).toBe(true); if(!claim.claimed)return;
    await f.call(claim.run.runToken,'myco_search',{query:'seam'});
    for(const id of ['h1','h2']) await f.call(claim.run.runToken,'myco_run_curation',{op:'material',id});
    expect(await f.call(claim.run.runToken,'myco_spores',{op:'supersede',old_spore_id:'h1',new_spore_id:'h2',expect_revision:0,expect_status:'active',reason:'h2 covers h1'})).toMatchObject({status:'superseded'});
    await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{projectId:'proj_1',runId:claim.run.id,attemptId:claim.run.attemptId,status:'failed',error:'fixture ended before complete'});
    f.sqlite.run('UPDATE spore_curation_work SET due_at=?',[f.now]);
    expect(await f.poll()).toMatchObject({claimed:false});
    expect(f.sqlite.query('SELECT decision,failures FROM spore_curation_work').get()).toEqual({decision:'changed',failures:1});
    expect(f.sqlite.query('SELECT COUNT(*) n FROM agent_runs').get()).toEqual({n:1});
    expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_receipts').get()).toEqual({n:0});
    expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_owners').get()).toEqual({n:0});
    await f.add('later',[1,0],f.now+1); await f.discover(); expect((await f.poll()).claimed).toBe(true);
  }finally{f.sqlite.close();}
});

const topicVector=(i:number):number[]=>{
  if(i===0)return [1,0,0];
  const score=i===1?0.84:0.73+0.01*(i%6), angle=i===1?0:0.04*(i%4), side=Math.sqrt(1-score**2);
  return [score,side*Math.cos(angle),side*Math.sin(angle)];
};

test('the strong gate offers a lone pair, excludes distribution-typical noise, and keeps weak seeds cheap',async()=>{
  const f=await fixture();
  try {
    await f.enable(); await f.add('a',topicVector(0)); await f.add('b',topicVector(1)); await f.add('noise',[0.7,-Math.sqrt(1-0.7**2),0]);
    await f.discover();
    const row=f.sqlite.query<{members:string},[]>('SELECT members FROM spore_curation_work').get()!;
    expect(JSON.parse(row.members).map((m:{id:string})=>m.id)).toEqual(['a','b']);
  }finally{f.sqlite.close();}
  const g=await fixture();
  try {
    await g.enable(); await g.add('a',[1,0]); await g.add('b',[0.65,Math.sqrt(1-0.65**2)]);
    await g.discover(); expect(g.calls.query).toBe(2); expect(g.calls.get).toBe(2);
    expect(g.sqlite.query('SELECT COUNT(*) n FROM agent_runs').get()).toEqual({n:0});
  }finally{g.sqlite.close();}
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const { SCHEMA_STEPS } = await import('@myco-server-worker/db/schema.js');
  const { measuredStore } = await import('./helpers/read-budget.js');
  const { statementRecorder } = await import('../helpers/statement-recorder.js');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map(sql => d1.prepare(sql)));
    await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','p',1)").run();
    await d1.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','Agent','built-in',1,1)").run();
    await d1.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3800)
      INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at)
      SELECT 'proj_1',printf('s-%06d',x),'agent','body','decision',x FROM n`).run();
    await d1.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at,neighbor_mean,neighbor_std)
      SELECT project_id,'curation-fixture',record_id,type,record_id,revision,1,1,1,0.125 FROM embedding_versions WHERE type='spore'`).run();
    await settingsWriter(d1).setCapability('proj_1','spore_curation',true,'test',1);
    const meter = measuredStore(d1), recorded = statementRecorder(meter.db,{accounting:'d1'});
    const vectors = { ...g.env.vectors,
      get: async (_scope: unknown, ids: string[]) => ids.map(id=>({id,values:[1,0],metadata:{type:'spore' as const,record_id:id,revision:'fixture',status:'active',session_id:'',created_at:1,observation_type:'decision',release_state:'',release_confidence:''}})),
      query: async () => Array.from({length:16},(_,i)=>({id:`s-${String(i+1).padStart(6,'0')}`,score:0.5})),
    };
    const env = { ...g.env, db: recorded.db, vectors };
    meter.reset(); expect(await discoverSporeClusters(env,g.now)).toBe(0);
    const walkRows = meter.reads(); expect(walkRows).toBeLessThanOrEqual(430);
    const lookup = recorded.statements.find(s=>s.sql.includes('SELECT id,record_id,revision,neighbor_mean,neighbor_std'))!;
    const plan = (await d1.prepare(`EXPLAIN QUERY PLAN ${lookup.sql}`).bind(...lookup.binds).all<{detail:string}>()).results.map(row=>row.detail).join('\n');
    expect(plan).toContain('SEARCH embedding_receipts USING INDEX idx_embedding_receipts_spore (project_id=? AND model_key=? AND id=?)');
    expect(plan).not.toMatch(/SCAN/);
    await d1.prepare("UPDATE spore_curation_cursor SET active=0").run();
    await d1.prepare("UPDATE spore_curation_changes SET dirty=0,pending_at=NULL").run();
    await d1.prepare("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES('proj_1','new','agent','body','decision',4000)").run();
    await d1.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at,neighbor_mean,neighbor_std)
      SELECT project_id,'curation-fixture',record_id,type,record_id,revision,1,1,1,0.125 FROM embedding_versions WHERE record_id='new'`).run();
    meter.reset(); expect(await discoverSporeClusters(env,g.now)).toBe(0);
    const newRows = meter.reads(); expect(newRows).toBeLessThanOrEqual(80);
    expect(await d1.prepare('SELECT COUNT(*) n FROM spore_curation_work').first()).toEqual({n:0});
    console.info('CURATION_WEAK_GATE_ROWS',{corpus:3800,walkRows,newRows});
  } finally { await mf.dispose(); }
});

test('a varied thirty-spore topic fills eight, rejoins wisdom with leftovers, and terminates for consolidate and keep-all',async()=>{
  const size=30;
  for(const resolve of [true,false]) {
    const f=await fixture(); let runs=0, metWisdom=false;
    try {
      await f.enable(); await f.setting(500);
      await settingsWriter(f.db).setProjectLeaf('proj_1','agent.spore_curation.daily_runs',size,'test',f.now);
      for(let i=0;i<size;i++) await f.add(`t${String(i).padStart(2,'0')}`,topicVector(i));
      for(;runs<size;runs++) {
        await f.discover(); const claim=await f.poll(); if(!claim.claimed)break;
        const ctx=await f.ctx(claim.run.id,claim.run.attemptId);
        const members=curationAssignment(ctx.principal.kind==='run'?ctx.principal.runContext:null)!.members;
        if(runs===0)expect(members).toHaveLength(8);
        metWisdom ||= members.some(m=>m.id.startsWith('wisdom-')) && members.some(m=>m.id.startsWith('t'));
        if(resolve) {
          const result=await f.call(claim.run.runToken,'myco_spores',members.length===2
            ? {op:'supersede',old_spore_id:members[0]!.id,new_spore_id:members[1]!.id,expect_revision:members[0]!.revision,expect_status:'active',reason:'The target contains the entire topic.'}
            : {op:'consolidate',source_spore_ids:members,observation_type:'wisdom',consolidated_content:'All topic details preserved.',agent_line:'Retain all topic details.',reason:'One topic.'}) as {new_spore_id?:string;status?:string};
          expect(result.status).toBe(members.length===2?'superseded':'consolidated');
          if(result.new_spore_id)await f.add(result.new_spore_id,[0.76,Math.sqrt(1-0.76**2),0]);
        }
        expect(await f.call(claim.run.runToken,'myco_run_curation',{op:'complete',decision:resolve?'resolved':'keep',...(resolve?{}:{members}),reason:'One topic; all chosen members were read.'})).toEqual({completed:true});
        await recordReport(f.db,{projectId:'proj_1'},{runId:claim.run.id,agentId:'myco-agent',action:'curated',summary:'Curated topic',details:null,audit:null,createdAt:f.now});
        expect(await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{projectId:'proj_1',runId:claim.run.id,attemptId:claim.run.attemptId,status:'completed'})).toMatchObject({status:'completed'});
      }
      expect(runs).toBeLessThan(size);
      expect(f.sqlite.query("SELECT COUNT(*) n FROM spores WHERE status='active'").get()).toEqual({n:resolve?1:size});
      if(resolve) {expect(metWisdom).toBe(true);expect(runs).toBeLessThanOrEqual(Math.ceil((size-1)/7));}
      await f.discover(); const before={...f.calls}; await f.discover(); expect(await f.poll()).toMatchObject({claimed:false}); expect(f.calls).toEqual(before);
    }finally{f.sqlite.close();}
  }
});

test('oversized seed material drops its weakest non-anchor candidates before closing the pair',async()=>{
  const f=await fixture();
  try {
    await f.enable(); await f.add('a',topicVector(0),f.now,'a'.repeat(4000)); await f.add('b',topicVector(1),f.now,'b'.repeat(4000));
    await f.add('high',topicVector(5),f.now,'h'.repeat(8000)); await f.add('low',topicVector(6),f.now,'l'.repeat(20000)); await f.discover();
    const claim=await f.poll(); expect(claim.claimed).toBe(true); if(!claim.claimed)return;
    const ctx=await f.ctx(claim.run.id,claim.run.attemptId);
    expect(curationAssignment(ctx.principal.kind==='run'?ctx.principal.runContext:null)!.members.map(m=>m.id)).toEqual(['a','b','high']);
  }finally{f.sqlite.close();}
  const g=await fixture();
  try {
    await g.enable(); await g.add('a',[1,0],g.now,'a'.repeat(18000)); await g.add('b',[1,0],g.now,'b'.repeat(18000)); await g.discover();
    expect(await g.poll()).toMatchObject({claimed:false}); expect(g.sqlite.query('SELECT decision FROM spore_curation_work').get()).toEqual({decision:'oversized'});
  }finally{g.sqlite.close();}
});

test('mutual standardized closeness rejects a cosine hub and admits a tight moderate pair under compressed models',async()=>{
  for(const scale of [1,0.3])for(const hub of [false,true]) {
    const f=await fixture();
    try {
      const similarity=hub?0.95:0.65, side=Math.sqrt(1-scale), amplitude=Math.sqrt(scale);
      const a=[amplitude,0,side,0,0], b=[amplitude*similarity,amplitude*Math.sqrt(1-similarity**2),0,side,0];
      const candidate=[amplitude*0.55,amplitude*Math.sqrt(1-0.55**2),0,0,side];
      const tight={mean:1-scale+scale*0.6,std:scale*0.04};
      const other=hub?{mean:1-scale+scale*0.13,std:scale*0.1}:tight;
      await f.enable(); await f.add('a',a,f.now,'A',tight); await f.add('b',b,f.now,'B',other); await f.add('c',candidate,f.now,'C',tight); await f.discover();
      expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_work').get()).toEqual({n:hub?0:1});
      if(!hub)expect(JSON.parse(f.sqlite.query<{members:string},[]>('SELECT members FROM spore_curation_work').get()!.members).map((m:{id:string})=>m.id)).toEqual(['a','b','c']);
    }finally{f.sqlite.close();}
  }
});

test('missing statistics exclude both seed and candidate until model-scoped calibration arrives',async()=>{
  const f=await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b',[1,0],f.now,'B',null); await f.discover();
    expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_work').get()).toEqual({n:0});
    const before={...f.calls}; await f.discover(); expect(f.calls).toEqual(before);
    f.sqlite.run("UPDATE embedding_receipts SET neighbor_mean=0.4,neighbor_std=0.04 WHERE record_id='b'");
    expect(f.sqlite.query('SELECT dirty,pending_at FROM spore_curation_changes').get()).toEqual({dirty:1,pending_at:f.now});
    await f.discover(); expect(f.sqlite.query('SELECT COUNT(*) n FROM spore_curation_work').get()).toEqual({n:1});
  }finally{f.sqlite.close();}
  const g=await fixture();
  try {
    await g.enable(); await g.add('old'); await g.discover(); const before={...g.calls};
    g.sqlite.run('UPDATE embedding_receipts SET neighbor_mean=0.41,neighbor_std=0.041');
    await g.discover(); expect(g.calls).toEqual(before);
  }finally{g.sqlite.close();}
});

test('currency retires deleted architecture before merging current knowledge through the run surface', async () => {
  for (const mode of ['deleted','current','mixed','unanchored','no-map'] as const) {
    const f = await fixture();
    let inventoryReads=0;
    const prepare=f.env.db.prepare.bind(f.env.db);
    f.env.db.prepare=(sql)=>{if(sql.includes('r.repository_files AS files')) inventoryReads++;return prepare(sql);};
    try {
      const commit = 'a'.repeat(40);
      if (mode !== 'no-map') {
        const source = {url:'https://example.test/team/repo',branch:'main',commit};
        f.sqlite.run("INSERT INTO project_repositories(project_id,revision,url,branch,updated_at,updated_by) VALUES('proj_1','connection',?,'main',1,'test')",[source.url]);
        f.sqlite.run(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,run_context,repository_files)
          VALUES('proj_1','map-source','myco-agent','canopy-map','completed',1,?,?)`,[JSON.stringify({repository:source}),JSON.stringify(['src/current.ts','README.md','packages/myco-server/src/core/runs.ts',...(mode==='current'?Array.from({length:2000},(_,i)=>`packages/source/${i}-${'a'.repeat(80)}.ts`):[])])]);
        f.sqlite.run(`INSERT INTO canopy_maps(project_id,revision,artifact,input_hash,repository_url,repository_branch,repository_commit,source_run_id,generated_at)
          VALUES('proj_1','map','{}','hash',?,'main',?,'map-source',?)`,[source.url,commit,f.now]);
      }
      await f.enable();
      const ids = mode === 'mixed' ? ['a','b','c','d','e','f'] : ['a','b','c'];
      for (const id of ids) {
        const stale = mode === 'deleted' || (mode === 'mixed' && id < 'd');
        await f.add(id,[1,0],f.now,stale ? `Retired team sync uses packages/myco/src/daemon/api/${id}.ts:12.` : mode === 'unanchored' ? 'Keep ownership explicit and preserve accumulated history.' : 'Use src/current.ts.');
      }
      if (mode !== 'unanchored') f.sqlite.run("UPDATE spores SET file_path='src/removed.ts' WHERE id='a'");
      await f.discover();
      const claim = await f.poll(); expect(claim.claimed).toBe(true); if (!claim.claimed) throw new Error('curation was not claimed');
      expect(claim.run.instruction!.indexOf('First judge')).toBeLessThan(claim.run.instruction!.indexOf('Choose the topic'));
      expect(claim.run.instruction).toContain('curation_sources_missing');
      const claimReads=inventoryReads;
      expect(claimReads).toBe(1);
      const ctx = await f.ctx(claim.run.id,claim.run.attemptId);
      const assignment = curationAssignment(ctx.principal.kind === 'run' ? ctx.principal.runContext : null)!;
      const members = assignment.members;
      const rawContext=(await getRun(f.db,{projectId:'proj_1'},claim.run.id))!.runContext!;
      expect(new TextEncoder().encode(rawContext).length).toBeLessThan(8_000);
      expect(assignment.snapshot).toEqual(mode==='no-map'?{available:false,reason:'no_code_map'}:{available:true,commit,generatedAt:f.now});
      const rows = f.sqlite.query<{spore_id:string;currency:string},[]>('SELECT spore_id,currency FROM spore_curation_candidates').all();
      const fact = JSON.parse(rows.find(row=>row.spore_id==='a')!.currency);
      expect(claim.run.instruction).toContain(`"currency":${JSON.stringify(fact)}`);
      expect(fact).toMatchObject(mode === 'no-map' ? {available:false,reason:'no_code_map'} : {available:true,commit});
      if (mode === 'unanchored') expect(fact).toEqual({available:true,commit,present:[],missing:[],unresolved:[]});
      if (mode === 'deleted' || mode === 'mixed') expect(fact).toEqual({available:true,commit,present:[],missing:['packages/myco/src/daemon/api/a.ts','src/removed.ts'],unresolved:[]});
      const merge = (sources: typeof members) => f.call(claim.run.runToken,'myco_spores',{op:'consolidate',source_spore_ids:sources,observation_type:'wisdom',consolidated_content:'Keep current specifics.',agent_line:'Use the current seam.',reason:'Same current seam.'});
      if (mode === 'current') {
        await f.add('searched',[1,0],f.now,'The dropped feature used src/deleted-search.ts.');
        await f.call(claim.run.runToken,'myco_search',{query:'same topic',type:'spore',status:'active',mode:'semantic'});
        expect(await f.call(claim.run.runToken,'myco_run_curation',{op:'material',id:'searched'})).toMatchObject({spore:{currency:{available:true,commit,present:[],missing:['src/deleted-search.ts']}}});
        expect(await merge([...members.slice(0,2),{id:'searched',revision:0}])).toMatchObject({ok:false,code:'curation_sources_missing'});
        expect(await f.call(claim.run.runToken,'myco_spores',{op:'obsolete',id:'searched',expect_revision:0,expect_status:'active',reason:'The feature in src/deleted-search.ts was removed.'})).toMatchObject({status:'obsolete'});
        const nextCommit='b'.repeat(40);
        f.sqlite.run(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,run_context,repository_files)
          VALUES('proj_1','next-map-source','myco-agent','canopy-map','completed',1,?,?)`,[JSON.stringify({repository:{url:'https://example.test/team/repo',branch:'main',commit:nextCommit}}),JSON.stringify(['src/after-move.ts'])]);
        f.sqlite.run("UPDATE canopy_maps SET source_run_id='next-map-source',repository_commit=?,generated_at=?",[nextCommit,f.now+1]);
        expect(f.sqlite.query("SELECT repository_files FROM agent_runs WHERE id='map-source'").get()).toEqual({repository_files:null});
        await f.add('after-move',[1,0],f.now,'Use src/after-move.ts.');
        await f.call(claim.run.runToken,'myco_search',{query:'same topic',type:'spore',status:'active',mode:'semantic'});
        expect(await f.call(claim.run.runToken,'myco_run_curation',{op:'material',id:'after-move'})).toMatchObject({spore:{currency:{available:false,reason:'snapshot_moved'}}});
        expect(await f.call(claim.run.runToken,'myco_run_curation',{op:'material',id:'after-move'})).toMatchObject({spore:{currency:{available:false,reason:'snapshot_moved'}}});
        f.sqlite.run("UPDATE spore_curation_candidates SET currency=NULL WHERE spore_id='b'");
        expect(await f.call(claim.run.runToken,'myco_run_curation',{op:'material',id:'b'})).toMatchObject({spore:{currency:null}});
      }
      if (mode === 'deleted' || mode === 'mixed') {
        expect(await merge(members)).toMatchObject({ok:false,code:'curation_sources_missing'});
        expect(await f.call(claim.run.runToken,'myco_spores',{op:'supersede',old_spore_id:'a',new_spore_id:'b',expect_revision:0,expect_status:'active',reason:'Same guidance.'})).toMatchObject({ok:false,code:'curation_sources_missing'});
        expect(f.sqlite.query("SELECT COUNT(*) n FROM spores WHERE observation_type='wisdom'").get()).toEqual({n:0});
        for (const id of ['a','b','c']) expect(await f.call(claim.run.runToken,'myco_spores',{op:'obsolete',id,expect_revision:0,expect_status:'active',reason:`Retired team sync: packages/myco/src/daemon/api/${id}.ts is absent from the committed snapshot.`})).toMatchObject({status:'obsolete'});
        expect(f.sqlite.query("SELECT COUNT(*) n FROM spores WHERE status='obsolete'").get()).toEqual({n:3});
      }
      if (mode !== 'deleted') expect(await merge(members.filter(member => mode !== 'mixed' || member.id >= 'd'))).toMatchObject({status:'consolidated'});
      expect(await f.call(claim.run.runToken,'myco_run_curation',{op:'complete',decision:'resolved',reason:'Retired outdated members before merging current guidance.'})).toEqual({completed:true});
      expect(f.sqlite.query("SELECT COUNT(*) n FROM spores WHERE observation_type='wisdom'").get()).toEqual({n:mode==='deleted'?0:1});
      expect(await f.call(claim.run.runToken,'myco_run',{op:'report',action:'curated',summary:'Currency judged before merging.',details:'Retired old guidance.\nKept current specifics.'})).toMatchObject({recorded:true});
      const report = f.sqlite.query<{details:string;summary:string},[string]>('SELECT details,summary FROM agent_reports WHERE run_id=?').get(claim.run.id)!;
      expect(report.details).toBe('Retired old guidance.\nKept current specifics.');
      expect(report.summary).toContain(`${mode==='deleted'||mode==='mixed'?3:mode==='current'?1:0} retired · 0 replaced · ${mode==='deleted'?0:3} merged`);
      expect(await runCloseRefusal(f.db,{projectId:'proj_1'},(await getRun(f.db,{projectId:'proj_1'},claim.run.id))!)).toBeNull();
      expect(inventoryReads).toBe(claimReads+(mode==='current'?2:0));
      expect(await endLeasedRun(f.env,{principal:f.principal,now:f.now+1},{projectId:'proj_1',runId:claim.run.id,attemptId:claim.run.attemptId,status:'completed'})).toMatchObject({status:'completed'});
      expect(JSON.parse((await getRun(f.db,{projectId:'proj_1'},claim.run.id))!.runContext!).curation.snapshot).toEqual(assignment.snapshot);
    } finally { f.sqlite.close(); }
  }
});


test('currency resolves package-relative anchors conservatively and respects snapshot age',()=>{
  const inventory={commit:'snapshot',generatedAt:100,files:['packages/myco-server/src/core/runs.ts','tests/current.test.ts','docs/guide.md']};
  const currency=(content:string,createdAt=100,updatedAt:number|null=null)=>sporeCurrency({filePath:null,content,createdAt,updatedAt},inventory,true);
  expect(currency('Use `core/runs.ts`.')).toEqual({available:true,commit:'snapshot',present:['core/runs.ts'],missing:[],unresolved:[]});
  expect(currency('See `packages/myco-server/`.')).toMatchObject({available:true,present:['packages/myco-server'],missing:[]});
  expect(currency('See `runs.ts`.')).toMatchObject({available:true,present:['runs.ts'],missing:[]});
  expect(currency('See `missing.ts`.')).toEqual({available:false,reason:'unresolved_anchors',unresolved:['missing.ts']});
  for(const token of ['@cf/baai/bge-m3','@stablelib/sha256','agents.id','origin/main..HEAD','169.254.0.0/16']) expect(sporeCodeAnchors({filePath:null,content:`Use \`${token}\`.`},inventory)).toEqual([]);
  expect(allAnchorsMissing(currency('Use packages/myco/src/daemon/routes/team.ts.'))).toBe(true);
  expect(currency('Use packages/myco/src/daemon/routes/team.ts.',101)).toEqual({available:false,reason:'snapshot_behind'});
  expect(currency('Use packages/myco/src/daemon/routes/team.ts.',90,101)).toEqual({available:false,reason:'snapshot_behind'});
  expect(allAnchorsMissing(null)).toBe(false);
});
