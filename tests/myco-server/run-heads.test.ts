import { expect, it } from 'bun:test';
import { budgetFixture } from './helpers/budget-fixture.js';
import { dispatchLoad, admissionReady, liveTriggers } from '@myco-server-worker/db/runs/live.js';
import { nextClaimable, queueHeads, queuedWaits, readTaskBudgetHolds, recordTaskHolder, recordQueueHolder } from '@myco-server-worker/db/runs/queue.js';
import { todayQueued } from '@myco-server-worker/db/runs/now.js';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { V719_STATEMENTS } from '@myco-server-worker/db/schema-v719.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { readWorkNow } from '@myco-server-worker/read/work-now.js';
import { heldBy } from '@myco-server-worker/core/limits.js';
import { NO_LIMITS } from '@myco-server-worker/core/runs.js';

it('keeps exact queue counts and oldest identities through claim, requeue, deletion and cross-Project keys', async () => {
  const f = await budgetFixture();
  try {
    f.sqlite.run("INSERT INTO projects(project_id,name,created_at) VALUES('other','Other',1)");
    const first = f.queue('z-first', 'manual', 'proj_1', 'title-summary', f.now - 2);
    f.queue('a-second', 'manual', 'proj_1', 'title-summary', f.now - 1);
    f.queue('z-first', 'manual', 'other', 'title-summary', f.now);
    expect((await queueHeads(f.db, [])).map(row => [row.projectId, row.id])).toEqual([['proj_1', 'z-first']]);
    expect(await todayQueued(f.db, { projectId: 'proj_1' })).toMatchObject([{ count: 2, oldest_id: 'z-first' }]);
    expect(await dispatchLoad(f.db, 'title-summary', f.now)).toMatchObject({ liveRuns: 0, liveTaskRuns: 0 });
    expect(await f.claim(first)).not.toBeNull();
    expect(await dispatchLoad(f.db, 'title-summary', f.now)).toMatchObject({ liveRuns: 1, liveTaskRuns: 1 });
    expect(await todayQueued(f.db, { projectId: 'proj_1' })).toMatchObject([{ count: 1, oldest_id: 'a-second' }]);
    f.sqlite.run("UPDATE agent_runs SET status='queued',dispatched_by=NULL WHERE project_id='proj_1' AND id='z-first'");
    expect(await todayQueued(f.db, { projectId: 'proj_1' })).toMatchObject([{ count: 2, oldest_id: 'z-first' }]);
    f.sqlite.run("DELETE FROM agent_runs WHERE project_id='proj_1' AND id='z-first'");
    expect(await todayQueued(f.db, { projectId: 'proj_1' })).toMatchObject([{ count: 1, oldest_id: 'a-second' }]);
    expect(await todayQueued(f.db, { projectId: 'other' })).toMatchObject([{ count: 1, oldest_id: 'z-first' }]);
  } finally { f.sqlite.close(); }
});

it('publishes task holds and runs marks through queued waits', async () => {
  const f = await budgetFixture();
  try {
    const first = f.queue('first');
    f.queue('second');
    const mark = () => f.sqlite.query("SELECT revision FROM change_marks WHERE kind='runs'").get();
    const before = mark();
    await recordTaskHolder(f.db, ['title-summary'], [null], 'fleet');
    expect(mark()).not.toEqual(before);
    const waits = await queuedWaits(f.db, { projectId: 'proj_1' }, ['first', 'second', 'absent']);
    expect([...waits.keys()]).toEqual(['first', 'second']);
    expect(waits.get('first')).toMatchObject({ reason: 'fleet', taskQueued: 2, task: 'title-summary' });
    expect(waits.get('second')).toEqual(waits.get('first'));
    const held = mark();
    await recordTaskHolder(f.db, ['title-summary'], ['fleet'], 'fleet');
    expect(mark()).toEqual(held);
    await recordQueueHolder(f.db, { projectId: 'proj_1' }, first.id, 'budget', { usd: 0.7, at: f.now });
    expect((await queuedWaits(f.db, { projectId: 'proj_1' }, ['second'])).get('second')).toMatchObject({ reason: 'budget', since: f.now });
    expect(mark()).not.toEqual(held);
  } finally { f.sqlite.close(); }
});

it('guards simultaneous claims with one resolved concurrency limit and releases capacity once', async () => {
  const f = await budgetFixture();
  try {
    f.serverEnv.fleet = 3;
    await settingsWriter(f.db).setLeaf('agent.limits.concurrent_runs', 1, 'mem_worker', f.now);
    const a = f.queue('a', 'manual'), b = f.queue('b', 'manual');
    const outcomes = await Promise.all([f.claim(a), f.claim(b)]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await dispatchLoad(f.db, 'title-summary', f.now)).toMatchObject({ liveRuns: 1 });
    const claimed = outcomes.find(row => row !== null)!;
    f.sqlite.run("UPDATE agent_runs SET status='completed' WHERE project_id=? AND id=?", [claimed.projectId, claimed.id]);
    f.sqlite.run("UPDATE agent_runs SET status='completed' WHERE project_id=? AND id=?", [claimed.projectId, claimed.id]);
    expect(await dispatchLoad(f.db, 'title-summary', f.now)).toMatchObject({ liveRuns: 0 });
    expect(await f.claim(claimed.id === a.id ? b : a)).not.toBeNull();
  } finally { f.sqlite.close(); }
});

it('selects queue heads against the supplied budget fence and sanitizes an invalid stored quote', async () => {
  const f = await budgetFixture();
  try {
    f.queue('automatic');
    const budget = { active: true, estimate: 0.1, profileJson: '' };
    expect(await nextClaimable(f.db, [], { ...budget, active: false }, f.now)).toBeNull();
    expect(await nextClaimable(f.db, [], { ...budget, stateKey: 'missing-estimate', observedEstimate: 'stale' }, f.now)).toBeNull();
    expect(await nextClaimable(f.db, [], budget, f.now)).toMatchObject({ id: 'automatic' });
    await recordQueueHolder(f.db, { projectId: 'proj_1' }, 'automatic', 'budget', { usd: 0.5, at: f.now });
    f.sqlite.run(`UPDATE agent_runs SET run_context='{"budgetEstimateUsd":"invalid","budgetQuotedAt":1.5}' WHERE id='automatic'`);
    expect((await readTaskBudgetHolds(f.db)).heldHeads).toMatchObject([{ requiredUsd: null, quotedAt: null }]);
    f.queue('manual', 'manual');
    expect(await nextClaimable(f.db, [], { ...budget, active: false }, f.now)).toMatchObject({ id: 'manual' });
  } finally { f.sqlite.close(); }
});

it('leaves populated admission building until bounded catch-up finishes and tolerates replay and interleaved writes', async () => {
  const f = await budgetFixture();
  try {
    for (const trigger of liveTriggers()) f.sqlite.exec(`DROP TRIGGER ${trigger.name}`);
    for (const table of ['task_runtime', 'task_due', 'admission_contribution', 'run_live']) f.sqlite.exec(`DROP TABLE ${table}`);
    f.sqlite.run("DELETE FROM projection_catchup WHERE projection='run_admission'");
    for (let n = 0; n < 110; n++) f.queue(`q-${String(n).padStart(3, '0')}`, 'manual');
    for (const sql of V719_STATEMENTS) f.sqlite.exec(sql);
    expect(await admissionReady(f.db)).toBe(false);
    expect((await queuedWaits(f.db, { projectId: 'proj_1' }, ['q-000'])).get('q-000'))
      .toMatchObject({ reason: 'queue_building', taskQueued: null, task: 'title-summary' });
    expect(heldBy(await dispatchLoad(f.db, 'title-summary', f.now), NO_LIMITS)).toBe('queue_building');
    expect((await readWorkNow(f.serverEnv, { projectId: 'proj_1' }, f.now, false)).waiting)
      .toContainEqual(expect.objectContaining({ key: 'queued:building', count: null, why: 'Waiting for the work queue to be ready.' }));
    expect(await f.claim({ projectId: 'proj_1', id: 'q-000', task: 'title-summary', instruction: null, dispatchSpec: null })).toBeNull();
    await catchUpProjections(f.db, { budget: { calls: 8, wallMs: 60_000 }, clock: () => f.now });
    expect(await admissionReady(f.db)).toBe(false);
    f.sqlite.run("DELETE FROM agent_runs WHERE id='q-000'");
    f.queue('a-late', 'manual');
    await catchUpProjections(f.db, { budget: { calls: 1000, wallMs: 60_000 }, clock: () => f.now });
    expect(await admissionReady(f.db)).toBe(true);
    expect(await todayQueued(f.db, { projectId: 'proj_1' })).toMatchObject([{ count: 110, oldest_id: 'a-late' }]);
    f.sqlite.run("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='run_admission'");
    await catchUpProjections(f.db, { budget: { calls: 1000, wallMs: 60_000 }, clock: () => f.now });
    expect(await todayQueued(f.db, { projectId: 'proj_1' })).toMatchObject([{ count: 110, oldest_id: 'a-late' }]);
  } finally { f.sqlite.close(); }
});

it('rolls back admission counts and queue consumption when a companion write fails', async () => {
  const f = await budgetFixture();
  try {
    f.queue('atomic', 'manual');
    await expect(f.db.batch([
      f.db.prepare("UPDATE agent_runs SET status='running' WHERE project_id='proj_1' AND id='atomic' RETURNING id"),
      f.db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','duplicate',1)"),
    ])).rejects.toThrow();
    expect(await dispatchLoad(f.db, 'title-summary', f.now)).toMatchObject({ liveRuns: 0 });
    expect(await todayQueued(f.db, { projectId: 'proj_1' })).toMatchObject([{ count: 1, oldest_id: 'atomic' }]);
  } finally { f.sqlite.close(); }
});

it('settles one same-run claim and preserves every admission fact on refusal on SQLite and D1', async () => {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const { SCHEMA_STEPS } = await import('@myco-server-worker/db/schema.js');
  const { completeBudgetMigration } = await import('@myco-server-worker/db/meta/budget-activation.js');
  const { claimQueuedRun } = await import('@myco-server-worker/core/worker-claim.js');
  const { PROFILE } = await import('./helpers/budget-fixture.js');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null)}}',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  const f = await budgetFixture();
  try {
    await settingsWriter(f.db).setLeaf('agent.limits.concurrent_runs', 1, 'mem_worker', f.now);
    const candidate = f.queue('contended', 'manual'), waiting = f.queue('waiting', 'manual');
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map(sql => d1.prepare(sql)));
    for (const table of ['members', 'member_credentials', 'projects', 'agents', 'project_capabilities', 'project_settings', 'deployment_settings', 'agent_runs']) {
      for (const row of f.sqlite.query<Record<string,unknown>,[]>(`SELECT * FROM ${table}`).all()) {
        const columns = Object.keys(row);
        await d1.prepare(`INSERT OR REPLACE INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).bind(...Object.values(row)).run();
      }
    }
    await completeBudgetMigration(d1, f.now);
    for (const db of [f.db, d1]) {
      const claim = (run: typeof candidate) => claimQueuedRun({ ...f.serverEnv, db }, run,
        { worker: f.principal, leaseExpiresAt: f.now + 60_000, harness: 'codex', profile: PROFILE, now: f.now });
      const results = await Promise.all([claim(candidate), claim(candidate)]);
      expect(results.filter(result => result !== null)).toHaveLength(1);
      expect((await db.prepare("SELECT run_id FROM agent_run_attempts WHERE run_id='contended'").all()).results).toEqual([{ run_id: 'contended' }]);
      const snapshot = async () => Promise.all(['run_live', 'task_due', 'task_runtime', 'admission_contribution'].map(async table =>
        (await db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).results));
      const before = await snapshot();
      expect(await claim(waiting)).toBeNull();
      expect(await snapshot()).toEqual(before);
      expect((await db.prepare("SELECT run_id FROM agent_run_attempts WHERE run_id='waiting'").all()).results).toEqual([]);
    }
  } finally { f.sqlite.close(); await mf.dispose(); }
}, 60_000);

it('keeps manual waiting reasons and active power separate from an automatic budget head', async () => {
  const f=await budgetFixture();
  try {
    f.queue('automatic','automatic'); f.queue('manual-one','manual'); f.queue('manual-two','manual');
    await recordQueueHolder(f.db,{projectId:'proj_1'},'automatic','budget',{usd:1,at:f.now});
    const before=await readWorkNow(f.serverEnv,{projectId:'proj_1'},f.now,false);
    expect(before.waiting).toContainEqual(expect.objectContaining({count:1,why:expect.stringContaining('daily budget')}));
    expect(before.waiting).toContainEqual(expect.objectContaining({count:2,why:expect.stringContaining('runner')}));
    const {endQueuedRun}=await import('@myco-server-worker/core/harness.js');
    await endQueuedRun(f.serverEnv,{projectId:'proj_1'},{id:'automatic'},f.now,{skipped:'test'});
    const after=await readWorkNow(f.serverEnv,{projectId:'proj_1'},f.now,false);
    expect(after.waiting.some(row=>/budget/i.test(row.why))).toBe(false);
    expect(after.waiting).toContainEqual(expect.objectContaining({count:2,why:expect.stringContaining('runner')}));
    const {engineAssertions}=await import('@myco-server-worker/core/tick.js');
    const assertions=await engineAssertions(f.serverEnv,f.now);
    expect(assertions).toContainEqual({name:'queue:pending',maxDepth:'active'});
    expect(assertions.some(row=>row.name==='queue:budget')).toBe(false);
  } finally {f.sqlite.close();}
});

it('settles a departed head hold and preserves a budget-held successor until its own expiry', async () => {
  const f=await budgetFixture();
  try {
    f.queue('capacity','automatic','proj_1','title-summary',f.now-1);
    f.queue('budget','automatic');
    await recordQueueHolder(f.db,{projectId:'proj_1'},'capacity','task_concurrent_runs');
    await recordQueueHolder(f.db,{projectId:'proj_1'},'budget','budget',{usd:0.1,at:f.now});
    const {runStaleSweep,QUEUE_MAX_AGE_MS,BUDGET_QUEUE_MAX_AGE_MS}=await import('@myco-server-worker/core/jobs-run.js');
    await runStaleSweep(f.serverEnv,f.now+QUEUE_MAX_AGE_MS+3_600_000);
    expect(f.sqlite.query("SELECT status,error_code FROM agent_runs WHERE id='capacity'").get()).toEqual({status:'failed',error_code:'machine_did_not_start'});
    expect(f.sqlite.query("SELECT status FROM agent_runs WHERE id='budget'").get()).toEqual({status:'queued'});
    expect((await readWorkNow(f.serverEnv,{projectId:'proj_1'},f.now+QUEUE_MAX_AGE_MS+3_600_000,false)).waiting)
      .toContainEqual(expect.objectContaining({count:1,why:expect.stringContaining('daily budget')}));
    await runStaleSweep(f.serverEnv,f.now+BUDGET_QUEUE_MAX_AGE_MS+1);
    expect(f.sqlite.query("SELECT status,error_code FROM agent_runs WHERE id='budget'").get()).toEqual({status:'failed',error_code:'budget_wait_expired'});
  } finally {f.sqlite.close();}
});

it('readies manual admission before historical catch-up and shows no empty queue building row', async () => {
  const f=await budgetFixture();
  try {
    f.sqlite.run(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<5000)
      INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at)
      SELECT 'proj_1','history-'||i,'myco-agent','title-summary','completed',1,2 FROM n`);
    const {resetProjectionCatchup}=await import('@myco-server-worker/db/projections/catchup.js');
    await resetProjectionCatchup(f.db);
    expect((await readWorkNow(f.serverEnv,{projectId:'proj_1'},f.now,false)).waiting.some(row=>row.key==='queued:building')).toBe(false);
    const manual=f.queue('manual','manual');
    expect((await readWorkNow(f.serverEnv,{projectId:'proj_1'},f.now,false)).waiting)
      .toContainEqual(expect.objectContaining({key:'queued:building',why:'Waiting for the work queue to be ready.'}));
    await catchUpProjections(f.db);
    expect(await admissionReady(f.db)).toBe(true);
    expect(await f.claim(manual)).not.toBeNull();
  } finally {f.sqlite.close();}
});

it('shows the real wait after catch-up readies a run refused while the queue builds', async () => {
  const f = await budgetFixture();
  try {
    const { claimNextRun } = await import('@myco-server-worker/core/harness.js');
    const { offeredHarness } = await import('./helpers/offered-harness.js');
    const { resetProjectionCatchup } = await import('@myco-server-worker/db/projections/catchup.js');
    f.queue('building-manual', 'manual');
    await resetProjectionCatchup(f.db);
    const { recordQueued } = await import('@myco-server-worker/db/runs/claim.js');
    expect(await recordQueued(f.db, { projectId: 'proj_1' }, {
      id: 'new-dispatch', agentId: 'myco-agent', task: 'title-summary', provider: null, model: null,
      heldBy: 'queue_building', queuedAt: f.now, dispatchSpec: JSON.stringify({ actor: 'mem_worker' }),
    })).toBe(true);
    await recordQueueHolder(f.db, { projectId: 'proj_1' }, 'new-dispatch', 'queue_building');
    expect(await claimNextRun(f.serverEnv, {
      principal: f.principal, harnesses: [offeredHarness('codex')], now: f.now,
    })).toEqual({ claimed: false, reason: 'at_limit' });
    expect((await readWorkNow(f.serverEnv, { projectId: 'proj_1' }, f.now, false)).waiting)
      .toContainEqual(expect.objectContaining({ count: null, why: 'Waiting for the work queue to be ready.' }));
    await catchUpProjections(f.db);
    expect(await admissionReady(f.db)).toBe(true);
    const waiting = (await readWorkNow(f.serverEnv, { projectId: 'proj_1' }, f.now, false)).waiting;
    expect(waiting).toContainEqual(expect.objectContaining({ count: 2, why: expect.stringContaining('runner') }));
    expect(waiting.some(row => row.why.includes('queue to be ready'))).toBe(false);
  } finally { f.sqlite.close(); }
});
