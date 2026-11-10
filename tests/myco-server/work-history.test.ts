/**
 * Work history's maintained rollups: built by the shared catch-up, kept by source writes, and read as `building`
 * until catch-up finishes.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { catchUpProjections, resetProjectionCatchup } from '@myco-server-worker/db/projections/catchup.js';
import { WORK_TIMELINE_PAGE } from '@myco-server-worker/db/runs/history.js';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { measuredStore } from './helpers/read-budget.js';
import { schemaD1Root } from './helpers/schema-template.js';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const SINCE = Math.floor(NOW / DAY) * DAY;
const window = `since=${SINCE}&until=${SINCE + DAY}`;

async function rig() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const { sqlite, db } = fixture;
  sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, ?)`, [NOW]);
  const run = (project: string, id: string, task: string, status: string, at: number, extra: { tokens?: number; cost?: number; dryRun?: number } = {}) =>
    sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, tokens_used, cost_usd, dry_run) VALUES (?, ?, 'agent_1', ?, ?, ?, ?, ?, ?, ?)`,
      [project, id, task, status, at - 1000, at, extra.tokens ?? null, extra.cost ?? null, extra.dryRun ?? 0]);
  const spore = (project: string, id: string, author: string, session: string) => {
    sqlite.run(`INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES (?, ?, 'm1', 'tok_1', ?, ?)`, [project, session, NOW, NOW]);
    sqlite.run(`INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, author, created_at) VALUES (?, ?, 'agent_1', ?, 'gotcha', 'active', 'x', ?, ?)`, [project, id, session, author, NOW]);
  };
  const get = async (path: string) => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(fixture.db, Date.now()), 'cf-connecting-ip': '1.2.3.4' } }), env);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const rows = (table: string, columns: string) => sqlite.query(`SELECT ${columns} FROM ${table} ORDER BY 1, 2`).all() as Record<string, unknown>[];
  return { sqlite, db, run, spore, get, rows };
}

const drain = async (db: Parameters<typeof catchUpProjections>[0]) => { while ((await catchUpProjections(db)).more) { /* drains every page */ } };

/** Clears the projection, as a deployment over history finds it before catch-up has read it. */
function clearProjection(sqlite: { run: (sql: string) => unknown }) {
  sqlite.run('DELETE FROM work_run_contribution');
  sqlite.run('DELETE FROM run_output_membership');
  sqlite.run(`UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='work_history'`);
}

describe('work history', () => {
  it('answers building until catch-up finishes, then the same totals as live maintenance, and a replay changes nothing', async () => {
    const r = await rig();
    try {
      r.run('proj_1', 'run_1', 'extract-curate', 'completed', SINCE + 1000, { tokens: 100, cost: 0.1 });
      r.spore('proj_1', 'sp_1', 'run_1', 's_1');
      r.run('proj_1', 'run_2', 'extract-curate', 'failed', SINCE + 2000);
      r.run('proj_1', 'run_3', 'title-summary', 'completed', SINCE + 3000);
      r.sqlite.run(`INSERT INTO agent_run_events (project_id, run_id, event_type, tool_name, outcome, payload, recorded_at) VALUES ('proj_1', 'run_3', 'run_write', 'myco_run_sessions', 'written', ?, ?)`, [JSON.stringify({ op: 'title', session_id: 's_2' }), NOW]);
      const live = (await r.get(`/api/work?${window}`)).body;
      expect(live.state).toBe('ready');
      expect(live.summary).toHaveLength(2);
      const facts = r.rows('work_run_contribution', '*');
      const totals = r.rows('work_window_totals', '*');

      clearProjection(r.sqlite);
      const building = (await r.get(`/api/work?${window}`)).body;
      expect({ state: building.state, summary: building.summary, timeline: building.timeline }).toEqual({ state: 'building', summary: null, timeline: [] });

      await drain(r.db);
      const ready = (await r.get(`/api/work?${window}`)).body;
      expect(ready).toEqual(live);
      expect(r.rows('work_run_contribution', '*')).toEqual(facts);
      expect(r.rows('work_window_totals', '*')).toEqual(totals);

      await resetProjectionCatchup(r.db);
      await drain(r.db);
      expect((await r.get(`/api/work?${window}`)).body).toEqual(live);
    } finally { r.sqlite.close(); }
  });

  it('holds a contribution to its sources: a late spore, a cost that arrives, a run reopened, a correction of the output', async () => {
    const r = await rig();
    try {
      r.run('proj_1', 'run_1', 'extract-curate', 'completed', SINCE + 1000, { tokens: 100 });
      r.spore('proj_1', 'sp_1', 'run_1', 's_1');
      const week = `since=${SINCE - 6 * DAY}&until=${SINCE + DAY}`;
      const outcome = async (q = window) => (await r.get(`/api/work?${q}`)).body.summary[0];
      expect(await outcome()).toMatchObject({ runs: { completed: 1 }, runsWithoutCost: 1, outcome: { spores: 1, sessions: 1 } });

      // A spore written after the run ended counts, and a session stays distinct.
      r.spore('proj_1', 'sp_2', 'run_1', 's_1');
      r.spore('proj_1', 'sp_3', 'run_1', 's_2');
      expect((await outcome()).outcome).toMatchObject({ spores: 3, sessions: 2 });
      expect((await outcome(week)).outcome).toMatchObject({ spores: 3, sessions: 2 });

      // A cost settling later is folded in, and the run no longer counts as reporting none.
      r.sqlite.run(`UPDATE agent_runs SET cost_usd = 0.25 WHERE id = 'run_1'`);
      expect(await outcome()).toMatchObject({ costUsd: 0.25, runsWithoutCost: 0 });

      // A spore's session corrected moves its membership and nothing drifts.
      r.sqlite.run(`UPDATE spores SET session_id = 's_1' WHERE id = 'sp_3'`);
      expect((await outcome()).outcome).toMatchObject({ spores: 3, sessions: 1 });

      // A run put back in flight leaves history entirely until it ends again.
      r.sqlite.run(`UPDATE agent_runs SET status = 'running', completed_at = NULL WHERE id = 'run_1'`);
      expect((await r.get(`/api/work?${window}`)).body.summary).toEqual([]);
      expect(r.rows('work_daily', 'project_id, runs')).toEqual([]);
      expect(r.rows('work_window_totals', 'project_id, sessions')).toEqual([]);
    } finally { r.sqlite.close(); }
  });

  it('never double counts a session across two runs, on the day it left and the week that still holds it', async () => {
    const r = await rig();
    try {
      r.run('proj_1', 'a', 'extract-curate', 'completed', SINCE - 2 * DAY);
      r.spore('proj_1', 'sp_a', 'a', 's_shared');
      r.run('proj_1', 'b', 'extract-curate', 'completed', SINCE + 1000);
      r.spore('proj_1', 'sp_b', 'b', 's_shared');
      const week = `since=${SINCE - 6 * DAY}&until=${SINCE + DAY}`;
      expect((await r.get(`/api/work?${week}`)).body.summary[0].outcome).toMatchObject({ spores: 2, sessions: 1 });
      r.sqlite.run(`DELETE FROM agent_runs WHERE id = 'b'`);
      expect((await r.get(`/api/work?${week}`)).body.summary[0].outcome).toMatchObject({ spores: 1, sessions: 1 });
      expect((await r.get(`/api/work?${window}`)).body.summary).toEqual([]);
    } finally { r.sqlite.close(); }
  });

  it('keeps a retired run off the timeline and its bounds off the rollup', async () => {
    const r = await rig();
    try {
      r.run('proj_1', 'small', 'canopy-map', 'completed', SINCE + 1000, { tokens: 10, cost: 0.1 });
      r.run('proj_1', 'large', 'canopy-map', 'completed', SINCE + 2000, { tokens: 1000, cost: 5 });
      r.sqlite.run(`INSERT INTO agent_run_events (project_id, run_id, event_type, tool_name, outcome, payload, recorded_at) VALUES ('proj_1', 'small', 'run_write', 'myco_run_map', 'written', '{}', ?)`, [NOW]);
      r.sqlite.run(`INSERT INTO agent_run_events (project_id, run_id, event_type, tool_name, outcome, payload, recorded_at) VALUES ('proj_1', 'large', 'run_write', 'myco_run_map', 'written', '{}', ?)`, [NOW]);
      expect((await r.get(`/api/work?${window}`)).body.timeline.map((row: any) => row.id)).toEqual(['large', 'small']);
      r.sqlite.run(`DELETE FROM agent_runs WHERE id = 'large'`);
      const { body } = await r.get(`/api/work?${window}`);
      expect(body.timeline.map((row: any) => row.id)).toEqual(['small']);
      expect(body.summary[0]).toMatchObject({ runs: { completed: 1 }, tokens: 10, spend: { tokens: [10, 10], costUsd: [0.1, 0.1] }, outcome: { maps: 1 } });
    } finally { r.sqlite.close(); }
  });

  it('pages a custom range by key, with no totals, and pages stay stable when a newer run lands', async () => {
    const r = await rig();
    try {
      const size = WORK_TIMELINE_PAGE + 5;
      for (let i = 0; i < size; i += 1) r.run('proj_1', `f_${String(i).padStart(3, '0')}`, 'canopy-map', 'failed', NOW - i * 1000);
      const page = async (cursor?: string) => (await r.get(`/api/work?since=${NOW - 3_600_000}&until=${NOW + 60_000}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`)).body;
      const first = await page();
      expect({ summary: first.summary, rows: first.timeline.length, hasMore: first.hasMore }).toEqual({ summary: null, rows: WORK_TIMELINE_PAGE, hasMore: true });

      r.run('proj_1', 'f_newer', 'canopy-map', 'failed', NOW + 1000);

      const second = await page(first.cursor);
      expect({ summary: second.summary, rows: second.timeline.length, hasMore: second.hasMore }).toEqual({ summary: null, rows: 5, hasMore: false });
      const seen = [...first.timeline, ...second.timeline].map((row: any) => row.id);
      expect(seen).toEqual(Array.from({ length: size }, (_, i) => `f_${String(i).padStart(3, '0')}`));
      expect((await page()).timeline[0].id).toBe('f_newer');
    } finally { r.sqlite.close(); }
  });

  it('judges a window\'s failures by themselves: an unrelated later failure does not reopen one a later run recovered', async () => {
    const r = await rig();
    try {
      const firstDay = SINCE - 10 * DAY;
      const between = `since=${firstDay}&until=${firstDay + DAY}`;
      const run = (id: string, status: string, startedAt: number | null, completedAt: number) => r.sqlite.run(
        `INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at) VALUES ('proj_1', ?, 'agent_1', 'canopy-map', ?, ?, ?)`, [id, status, startedAt, completedAt]);
      const failure = async (q: string) => (await r.get(`/api/work?${q}`)).body.summary[0].failure;

      run('a', 'failed', firstDay + 1000, firstDay + 2000);
      expect(await failure(between)).toMatchObject({ latestRunId: 'a', unresolved: true });

      run('b', 'completed', firstDay + 3000, firstDay + 4000);
      expect(await failure(between)).toMatchObject({ latestRunId: 'a', unresolved: false });

      run('c', 'failed', SINCE + 1000, SINCE + 2000);
      expect(await failure(between)).toMatchObject({ latestRunId: 'a', unresolved: false });
      expect(await failure(window)).toMatchObject({ latestRunId: 'c', unresolved: true });
    } finally { r.sqlite.close(); }
  });

  it('keeps the started and completed order: a run that started first recovers nothing, and a failure that never started counts from its end', async () => {
    const r = await rig();
    try {
      const run = (id: string, status: string, startedAt: number | null, completedAt: number) => r.sqlite.run(
        `INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at) VALUES ('proj_1', ?, 'agent_1', 'canopy-map', ?, ?, ?)`, [id, status, startedAt, completedAt]);
      const failure = async () => (await r.get(`/api/work?${window}`)).body.summary[0].failure;

      run('earlier', 'completed', SINCE + 1000, SINCE + 9000);
      run('overlapped', 'failed', SINCE + 2000, SINCE + 3000);
      expect(await failure()).toMatchObject({ latestRunId: 'overlapped', unresolved: true });

      run('later', 'completed', SINCE + 4000, SINCE + 5000);
      expect(await failure()).toMatchObject({ latestRunId: 'overlapped', unresolved: false });

      run('admission', 'failed', null, SINCE + 6000);
      expect(await failure()).toMatchObject({ latestRunId: 'admission', unresolved: true });
    } finally { r.sqlite.close(); }
  });

  it('moves a spend bound by a seek: settling a cost and retiring runs read the same rows whatever the day holds', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
    try {
      const d1 = await mf.getD1Database('DB');
      const measured = measuredStore(d1);
      await d1.prepare(`INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent_1','a','built-in',1,1)`).run();
      const rollup = (project: string) => d1.prepare(`SELECT runs,tokens_low,tokens_high,cost_low,cost_high,duration_low,duration_high FROM work_daily WHERE project_id=?`).bind(project).first();
      const recount = (project: string) => d1.prepare(`SELECT COUNT(*) AS runs,MIN(tokens) AS tokens_low,MAX(tokens) AS tokens_high,MIN(cost) AS cost_low,MAX(cost) AS cost_high,MIN(duration_ms) AS duration_low,MAX(duration_ms) AS duration_high FROM work_run_contribution WHERE project_id=?`).bind(project).first();
      const steps = [
        `UPDATE agent_runs SET cost_usd=2 WHERE project_id=?1 AND id='run_1'`,
        `UPDATE agent_runs SET cost_usd=1.5 WHERE project_id=?1 AND id='run_1'`,
        `UPDATE agent_runs SET tokens_used=50 WHERE project_id=?1 AND id='run_3'`,
        `UPDATE agent_runs SET tokens_used=100 WHERE project_id=?1 AND id='run_3'`,
        `DELETE FROM agent_runs WHERE project_id=?1 AND id='run_2'`,
        `DELETE FROM agent_runs WHERE project_id=?1 AND id='run_1'`,
      ];
      const reads: Record<string, number[]> = {};
      const finals: Record<string, unknown> = {};
      for (const [project, size] of [['proj_small', 200], ['proj_full', 4000]] as const) {
        await d1.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
        await d1.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,started_at,completed_at,tokens_used,cost_usd)
          SELECT ?1,'run_'||value,'agent_1','canopy-map','completed','automatic',?2,?3,100,1 FROM json_each(?4)`)
          .bind(project, SINCE + 1000, SINCE + 61_000, JSON.stringify(Array.from({ length: size }, (_, n) => n))).run();
        expect(await rollup(project)).toMatchObject({ runs: size, tokens_low: 100, tokens_high: 100, cost_low: 1, cost_high: 1, duration_low: 60_000, duration_high: 60_000 });
        reads[project] = [];
        for (const sql of steps) {
          measured.reset();
          await measured.db.prepare(sql).bind(project).run();
          reads[project]!.push(measured.reads());
          expect(await rollup(project)).toEqual(await recount(project));
        }
        finals[project] = await rollup(project);
      }
      expect(finals.proj_small).toMatchObject({ runs: 198, tokens_low: 100, cost_low: 1, cost_high: 1 });
      expect(finals.proj_full).toMatchObject({ runs: 3998, tokens_low: 100, cost_low: 1, cost_high: 1 });
      expect(reads.proj_full).toEqual(reads.proj_small!);
    } finally { await mf.dispose(); }
  }, 120_000);

  it('says why a queued run waits, in its task queue, on the run list and never counts ahead of it', async () => {
    const r = await rig();
    try {
      r.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by) VALUES ('proj_1', 'q_old', 'agent_1', 'title-summary', 'queued', ?, 'concurrent_runs')`, [NOW - 1000]);
      r.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by) VALUES ('proj_1', 'q_new', 'agent_1', 'title-summary', 'queued', ?, 'worker')`, [NOW]);
      const { status, body } = await r.get('/api/projects/proj_1/runs?status=queued');
      expect(status).toBe(200);
      expect(body.rows.map((row: any) => [row.id, row.waitReason, row.waitingSince, row.taskQueued])).toEqual([
        ['q_new', 'concurrent_runs', NOW - 1000, 2], ['q_old', 'concurrent_runs', NOW - 1000, 2],
      ]);
      expect(body.rows[0]).not.toHaveProperty('position');
    } finally { r.sqlite.close(); }
  });
});
