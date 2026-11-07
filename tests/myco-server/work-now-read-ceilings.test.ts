/**
 * The dashboard's heartbeat (`readWorkNow`) is read every tick while a page is open, so every statement it runs must
 * be a bounded seek: its rows read stay inside a ceiling however much history the store holds. Measured on both
 * stores, without planner statistics, over a store with thousands of finished runs, queued runs in another project,
 * sessions and a long event log on the running run.
 */
import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { readWorkNow, NOW_PROJECTS_MAX, NOW_QUEUED_MAX, NOW_RECENT_RUNS, NOW_RUNNING_MAX, NOW_WATCHED_TASKS } from '@myco-server-worker/read/work-now.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { statementRecorder } from '../helpers/statement-recorder.js';
import { sqliteBudgetMeter } from './helpers/budget-meter.js';

const NOW = 1_800_000_000_000;
const SIZE = 5000;
const RUNNING = 3;
/** Fixed reads every answer makes whatever the scope: settings, the fleet, the budget window and the marks. */
const FIXED = 60;
/** One project: its running runs with their latest step and call, its queued runs, its schedules and its failures. */
const PROJECT_LIMIT = FIXED + RUNNING * 6 + NOW_QUEUED_MAX + NOW_WATCHED_TASKS.length * NOW_RECENT_RUNS + 20;
/** Every project: the same, for at most `NOW_PROJECTS_MAX` projects, plus learning's bounded status read. */
const DEPLOYMENT_LIMIT = FIXED + NOW_RUNNING_MAX * 6 + NOW_QUEUED_MAX + NOW_PROJECTS_MAX * (NOW_WATCHED_TASKS.length * NOW_RECENT_RUNS + 6) + 400;

it('reads Myco’s work now in bounded seeks on both stores', async () => {
  const native = new Database(':memory:');
  const meter = sqliteBudgetMeter();
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) {
      for (const sql of step.statements) native.exec(sql);
      await d1.batch(step.statements.map(sql => d1.prepare(sql)));
    }
    for (const [target, db] of [['native', sqliteRelationalStore(native)], ['D1', d1]] as const) {
      const ids = JSON.stringify(Array.from({ length: SIZE }, (_, n) => n));
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('project','Project',1),('other','Other',1)").run();
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','Agent','built-in',1,1)").run();
      await db.prepare("INSERT INTO project_capabilities VALUES ('project','spore_curation',1,1,'fixture'), ('project','canopy',1,1,'fixture')").run();
      await db.prepare("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')").run();
      for (const task of [...NOW_WATCHED_TASKS, 'title-summary']) {
        await db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,started_at,completed_at,queued_at)
          SELECT 'project',?||'-'||value,'agent',?,CASE WHEN value % 3 = 0 THEN 'failed' ELSE 'completed' END,'automatic',value+1,value+2,value+1 FROM json_each(?)`)
          .bind(task, task, ids).run();
      }
      await db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,queued_at)
        SELECT 'other','queued-'||value,'agent','title-summary','queued','automatic',value FROM json_each(?)`).bind(ids).run();
      for (let n = 0; n < RUNNING; n += 1) {
        await db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,started_at,queued_at) VALUES('project',?,'agent','extract-curate','running','automatic',?,?)`)
          .bind(`live-${n}`, NOW - 60_000, NOW - 60_000).run();
        await db.prepare(`INSERT INTO agent_run_events(project_id,run_id,event_type,tool_name,outcome,payload,recorded_at)
          SELECT 'project',?,CASE WHEN value % 2 = 0 THEN 'run_tool' ELSE 'run_write' END,'myco_spores','success','{"op":"save"}',? + value FROM json_each(?)`)
          .bind(`live-${n}`, NOW - SIZE, JSON.stringify(Array.from({ length: 500 }, (_, i) => i))).run();
        await db.prepare(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at) VALUES('project',?,'a1','fixture',?)`).bind(`live-${n}`, NOW - 60_000).run();
        await db.prepare(`INSERT INTO agent_run_steps(project_id,run_id,attempt_id,seq,kind,tool,target,outcome,started_at,received_at)
          SELECT 'project',?,'a1',value,'read','Read','src/a.ts','ok',? + value,? FROM json_each(?)`)
          .bind(`live-${n}`, NOW - SIZE, NOW, JSON.stringify(Array.from({ length: 300 }, (_, i) => i))).run();
      }
      await db.prepare(`INSERT INTO spore_curation_work(project_id,cluster_key,members,due_at,failures,run_id) VALUES('project','k','[]',?,1,'curate-spores-3')`).bind(NOW + 60_000).run();
      await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,last_live_received_at)
        SELECT 'project',printf('session-%05d',value),'machine','token',1,value,value FROM json_each(?)`).bind(ids).run();

      const check = async (label: string, limit: number, action: (db: RelationalStore) => Promise<unknown>) => {
        const recorded = statementRecorder(db, { accounting: target === 'D1' ? 'd1' : 'native' });
        const snapshot = target === 'native' ? Database.deserialize(native.serialize()) : null;
        try {
          await action(recorded.db);
          let rows = 0;
          const heaviest: Array<{ rows: number; sql: string }> = [];
          for (const entry of recorded.statements) {
            const count = snapshot === null ? entry.rowsRead : meter.reads(snapshot, { sql: entry.sql, params: [...entry.binds] });
            expect(count).toBeDefined();
            rows += count!;
            heaviest.push({ rows: count!, sql: entry.sql.replace(/\s+/g, ' ').slice(0, 140) });
          }
          heaviest.sort((a, b) => b.rows - a.rows);
          console.info('WORK_NOW_READ_CEILING', JSON.stringify({ target, label, rows, limit, statements: recorded.statements.length, heaviest: heaviest.slice(0, 5) }));
          expect(rows, label).toBeLessThanOrEqual(limit);
        } finally { snapshot?.close(); }
      };
      await check('one project', PROJECT_LIMIT, async (store) => {
        const answer = await readWorkNow({ db: store } as never, { projectId: 'project' }, NOW, false);
        expect(answer.running.map((run) => run.runId).sort()).toEqual(['live-0', 'live-1', 'live-2']);
        expect(answer.running[0]!.step?.words).toMatch(/^(Saved a spore|Read src\/a\.ts)$/);
        expect(answer.needsYou.map((item) => item.key)).toContain('curation-group:project:k');
        expect(answer.unavailable).toEqual([]);
      });
      await check('every project', DEPLOYMENT_LIMIT, async (store) => {
        const answer = await readWorkNow({ db: store } as never, { all: true }, NOW, false);
        expect(answer.waiting.find((item) => item.projectId === 'other')?.count).toBe(NOW_QUEUED_MAX);
        expect(answer.unavailable).toEqual([]);
      });
    }
  } finally { native.close(); meter.close(); await mf.dispose(); }
}, 180_000);
