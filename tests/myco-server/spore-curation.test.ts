import { expect, test } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { memberHeaders } from './helpers/fixtures.js';
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

async function fixture() {
  const f = await budgetFixture();
  const vectors = cloudflareVectorStore(indexFixture());
  const env = { ...f.serverEnv, vectors, embeddingProvider: async () => ({ modelKey: 'curation-fixture', embed: async (): Promise<number[]> => { throw new Error('curation called the embedding model'); } }) };
  const enable = () => settingsWriter(f.db).setCapability('proj_1', 'spore_curation', true, 'test', f.now - 10);
  const add = async (id: string, values = [1, 0], created = f.now) => {
    f.sqlite.run(`INSERT OR IGNORE INTO spores(project_id,id,agent_id,content,observation_type,agent_line,created_at)
      VALUES('proj_1',?,'myco-agent',?,'decision','Use the named seam.',?)`, [id, `Whole content for ${id}`, created]);
    const source = f.sqlite.query<{ revision: string }, [string]>("SELECT revision FROM embedding_versions WHERE project_id='proj_1' AND type='spore' AND record_id=?").get(id)!;
    const partition = { projectId: 'proj_1', modelKey: 'curation-fixture' };
    const key = await vectorId(partition, 'spore', id, source.revision);
    await vectors.upsert(partition, [{ id: key, values, metadata: { type: 'spore', record_id: id, revision: source.revision, status: 'active', session_id: '', created_at: created, observation_type: 'decision', release_state: '', release_confidence: '' } }]);
    f.sqlite.run(`INSERT OR REPLACE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
      VALUES('proj_1','curation-fixture',?,'spore',?,?,1,?)`, [key, id, source.revision, f.now]);
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
  return { ...f, env, enable, add, discover, poll, ctx, call };
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
    await f.enable(); await f.add('a'); await f.add('b'); await f.discover();
    const claimed = await f.poll(); expect(claimed.claimed).toBe(true); if (!claimed.claimed) return;
    expect(claimed.run.profile).toMatchObject({ model: 'sonnet', effort: 'low' });
    expect(claimed.run.instruction).toContain('Whole content for a');
    expect(claimed.run.instruction).toContain('Whole content for b');
    expect(claimed.run).not.toHaveProperty('repository');
    const ctx = await f.ctx(claimed.run.id, claimed.run.attemptId);
    expect(await handleRunCuration({ op: 'complete', decision: 'resolved', reason: 'I claim I did it' }, ctx)).toMatchObject({ ok: false });
    expect(await f.call(claimed.run.runToken, 'myco_run_curation', { op: 'complete', decision: 'keep', reason: 'The two seams apply to distinct actors.' })).toEqual({ completed: true });
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
    expect(await handleRunCuration({ op: 'complete', decision: 'keep', reason: 'Keep' }, ctx)).toMatchObject({ code: 'material_changed' });
    expect(await handleSpores({ op: 'obsolete', id: 'a', expect_revision: assignment.members[0]!.revision, reason: 'obsolete' }, ctx)).toMatchObject({ ok: false });
    expect(f.sqlite.query("SELECT content,status FROM spores WHERE id='a'").get()).toEqual({ content: 'Concurrent edit', status: 'active' });
    expect(await handleSpores({ op: 'obsolete', id: 'b', expect_revision: 999, reason: 'obsolete' }, ctx)).toMatchObject({ ok: false });
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
    expect(seedForStage('curate-spores')).toBe(0.05);
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
      await d1.prepare("UPDATE spore_curation_clock SET after_project='' WHERE id=1").run();
      meter.reset(); await discoverSporeClusters(env, f.now); reads.push(meter.reads());
    }
    expect(reads[1]).toBeLessThanOrEqual(reads[0]! + 10);
    expect(reads[1]).toBeLessThan(200);
    expect(await d1.prepare('SELECT after_id FROM spore_curation_cursor').first()).toEqual({ after_id: `s-${String(CURATION_SEEDS_PER_TICK*2).padStart(6,'0')}` });
  } finally { await mf.dispose(); f.sqlite.close(); }
});

test('curation uses a fixed supported Sonnet low profile with no repository requirement', () => {
  const offered = offeredHarness('claude-code');
  expect(resolveExecutionProfile('curate-spores', offered.id, offered.profile, new Map([
    ['agent.reasoning_map.claude-code.low', '"opus"'], ['agent.effort_map.claude-code.low', '"max"'],
  ]))).toMatchObject({ profile: { tier: 'low', model: 'sonnet', effort: 'low' } });
  expect(resolveExecutionProfile('curate-spores', 'codex', offered.profile, new Map())).toHaveProperty('reason');
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
