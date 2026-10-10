import { expect, test } from 'bun:test';
import { Miniflare } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { runEmbeddingJob, embeddingKeepsAwake, hasEmbeddingWork } from '@myco-server-worker/core/embedding/jobs.js';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { runTick, tickPacer } from '@myco-server-worker/core/tick.js';
import { lastTaskEntryAt, lastTaskEntryQueries } from '@myco-server-worker/core/runs.js';
import { calibrationPending } from '@myco-server-worker/core/embedding/hubness.js';
import { embeddingSweep, hubnessSweep } from '@myco-server-worker/core/embedding/work-sweep.js';
import { WORK_SWEEP_MIN_MS, WORK_SWEEP_CONTINUE_MS, WORK_SWEEP_PAGE } from '@myco-server-worker/core/embedding/work-state.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { indexFixture } from './helpers/vector-index.js';
import { cloudflareVectorStore } from '@myco-server-worker/platform/cloudflare/vectors.js';
import { cloudflareEmbeddingProvider, EMBEDDING_MODEL } from '@myco-server-worker/platform/cloudflare/embedding.js';
import { measuredStore } from './helpers/read-budget.js';
import type { ServerEnv, RelationalStore } from '@myco-server-worker/core/adapters.js';

const NOW = 10 ** 12;
const MODEL = JSON.stringify(['cloudflare', EMBEDDING_MODEL]);
const TICKS = 10;

async function seedCaughtUp(d1: RelationalStore, size: number) {
  await d1.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT OR IGNORE INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
    SELECT 'p',printf('plan-%06d',x),'session','event','machine','body','hash','active',1,1,'token',1 FROM n`).bind(size).run();
  await d1.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT OR IGNORE INTO spores(project_id,id,agent_id,content,observation_type,created_at)
    SELECT 'p',printf('spore-%06d',x),'agent','body','decision',1 FROM n`).bind(size).run();
  await d1.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT OR IGNORE INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
    SELECT 'p',printf('session-%06d',x),'machine','token',1,1 FROM n`).bind(size).run();
  await d1.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
    SELECT project_id,?,record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id = 'p' AND type <> 'session'`).bind(MODEL).run();
  await d1.prepare(`INSERT INTO embedding_hubness_members(project_id,model_key,id,n,vector)
    SELECT project_id,model_key,id,?-1,'AACAPw==' FROM embedding_receipts WHERE project_id='p' AND model_key=? AND type='spore'
    ON CONFLICT(project_id,model_key,id) DO UPDATE SET n=excluded.n`).bind(size, MODEL).run();
}

test('caught-up D1 embedding wake reads stay constant as the corpus grows', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map((sql) => d1.prepare(sql)));
    await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
    await d1.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
    await d1.prepare("INSERT INTO members(id,label,created_at) VALUES('member','member',1)").run();
    await d1.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','member',1)").run();
    await d1.prepare(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES('token','member','machine','hash',1,?,'token',1)`).bind(NOW + 86_400_000).run();
    const measured = measuredStore(d1);
    const fixture = sqliteEnv();
    const env: ServerEnv = { ...fixture.serverEnv, db: measured.db, origin: 'http://local.invalid',
      vectors: cloudflareVectorStore(indexFixture()),
      embeddingProvider: async () => cloudflareEmbeddingProvider({ run: async () => ({ data: [[1, 0]] }) }, { model: EMBEDDING_MODEL, modelKey: MODEL }),
      harnessLaunch: async () => { throw new Error('idle project dispatched an embedding run'); },
    };
    const seeks: number[][] = [];
    const totals: number[] = [];
    const safety: number[] = [];
    const stale: number[] = [];
    const unrelated: number[][] = [];
    const history: number[] = [];
    for (const size of [2_000, 8_000]) {
      await seedCaughtUp(d1, size);
      await d1.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
        INSERT OR IGNORE INTO agent_runs(project_id,id,agent_id,task,status,started_at,queued_at)
        SELECT 'p',printf('run-%06d',x),'agent','embedding-reconcile','completed',?+x,?+x FROM n`).bind(size, NOW - 86_400_000, NOW - 86_400_000).run();
      measured.reset();
      expect(await lastTaskEntryAt(measured.db, { projectId: 'p' }, 'embedding-reconcile')).toBe(NOW - 86_400_000 + size);
      history.push(measured.reads());
      expect(measured.reads()).toBeLessThanOrEqual(8);
      for (const { sql, binds } of lastTaskEntryQueries({ projectId: 'p' }, 'embedding-reconcile')) {
        const details = (await d1.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map((row) => row.detail).join('\n');
        expect(details).toMatch(/idx_agent_runs_(skipped_)?entry/);
        expect(details).not.toContain('TEMP B-TREE');
      }
      expect(await hasEmbeddingWork(measured.db, 'p', MODEL, NOW)).toBe(false);
      const pages: number[] = [];
      for (const fraction of [0, 0.5, 0.9]) {
        const offset = Math.min(Math.floor(size * fraction), size - WORK_SWEEP_PAGE);
        const key = (type: string) => `${type}-${String(offset).padStart(6, '0')}`;
        const cursor = (phase: string, a: string, b: string) => JSON.stringify({ phase, a, b, count: 0, min: null, max: null, uncovered: false });
        const sweeps = [
          () => embeddingSweep(measured.db, 'p', [MODEL], [MODEL], NOW, cursor('sources', 'plan', key('plan'))),
          () => embeddingSweep(measured.db, 'p', [MODEL], [MODEL], NOW, cursor('receipts', MODEL, key('plan'))),
          () => hubnessSweep(measured.db, 'p', MODEL, NOW, cursor('receipts', '', key('spore')), true),
          () => hubnessSweep(measured.db, 'p', MODEL, NOW, cursor('members', MODEL, key('spore')), true),
        ];
        for (const sweep of sweeps) {
          measured.reset();
          expect((await sweep()).pending).toBe(false);
          pages.push(measured.reads());
          expect(measured.reads()).toBeLessThanOrEqual(2_048);
        }
      }
      seeks.push(pages);
      console.info(`embedding indexed sweep pages: ${size * 2} eligible sources/receipts, ${JSON.stringify(pages)} rows at beginning/middle/late cursors`);
      measured.reset();
      for (let tick = 1; tick <= TICKS; tick++) {
        expect(await embeddingKeepsAwake(env, NOW + tick * 1_000)).toBe(false);
        expect(await runEmbeddingJob(env, NOW + tick * 1_000)).toEqual({ changed: 0, more: false });
      }
      expect(measured.historyQueries()).toBe(0);
      totals.push(measured.reads() / TICKS);
      expect(totals.at(-1)).toBeLessThanOrEqual(100);
      console.info(`embedding read budget: ${size * 2} eligible sources/receipts, ${totals.at(-1)} rows/idle tick`);
      const checks: number[] = [];
      for (const kind of ['prompt', 'tool-input', 'tool-output']) {
        await d1.prepare(`INSERT INTO processed_resources(project_id,kind,resource_id,blob_key,source_token_id,event_id)
          VALUES('p',?,?, 'blob','token','event')`).bind(kind, `${kind}-${size}`).run();
        measured.reset();
        expect(await hasEmbeddingWork(measured.db, 'p', MODEL, NOW + 20_000)).toBe(false);
        checks.push(measured.reads());
      }
      for (const kind of ['session.start', 'session.end'] as const) {
        const written = await planEventWrite(measured.db, { projectId: 'p', machineId: 'machine', tokenId: 'token', bodyBytes: 100, now: NOW }, {
          eventId: crypto.randomUUID(), sessionId: `capture-${size}`, kind, channel: 'cli', createdAt: NOW,
          producer: { adapter: 'claude-code', version: '1' },
          payload: kind === 'session.start' ? { agent: 'claude-code', startedAt: NOW } : { endedAt: NOW },
        });
        if (!written.ok) throw new Error(JSON.stringify(written));
        expect(written.write.interpret(await measured.db.batch(written.write.statements))).toEqual({ persisted: true, projected: true });
        measured.reset();
        expect(await hasEmbeddingWork(measured.db, 'p', MODEL, NOW + 20_001)).toBe(false);
        checks.push(measured.reads());
      }
      unrelated.push(checks);
      expect(checks.every((reads) => reads <= 8)).toBe(true);
      console.info(`embedding unrelated writes: ${size * 2} sources, ${JSON.stringify(checks)} rows/check`);
      const pacer = tickPacer();
      Object.assign(pacer, { fullAt: NOW + WORK_SWEEP_MIN_MS, state: 'sleep', heldBy: 'embedding:sweep',
        draining: ['embedding-reconcile'] });
      measured.reset();
      for (let tick = 0; tick < 4; tick++) {
        const report = await runTick(env, NOW + WORK_SWEEP_MIN_MS + tick * WORK_SWEEP_CONTINUE_MS, { wake: 'clock', pacer });
        expect(report.drainOnly).toBe(true);
        expect(report.state).toBe('sleep');
        expect(report.jobs).toEqual([{ name: 'embedding-reconcile', changed: 0, failed: null, more: true, continueAfterMs: WORK_SWEEP_CONTINUE_MS }]);
        expect(report.nextWakeMs).toBe(WORK_SWEEP_CONTINUE_MS);
      }
      expect(measured.historyQueries()).toBe(0);
      safety.push(measured.reads() / 4);
      console.info(`embedding chained sweep budget: ${size * 2} sources, ${size} historical runs, ${safety.at(-1)} rows/tick`);

      await d1.prepare("UPDATE embedding_receipts SET revision='stale' WHERE project_id='p' AND type='spore'").run();
      expect(await calibrationPending(measured.db, 'p', MODEL, NOW)).toBe(false);
      measured.reset();
      for (let tick = 0; tick < 4; tick++) {
        expect(await calibrationPending(measured.db, 'p', MODEL, NOW + WORK_SWEEP_MIN_MS + tick * WORK_SWEEP_CONTINUE_MS)).toBe(false);
      }
      stale.push(measured.reads() / 4);
      console.info(`hubness stale-receipt safety budget: ${size} stale receipts, ${stale.at(-1)} rows/safety tick`);
      await d1.prepare(`UPDATE embedding_receipts SET revision=(SELECT revision FROM embedding_versions v
        WHERE v.project_id=embedding_receipts.project_id AND v.type=embedding_receipts.type AND v.record_id=embedding_receipts.record_id)
        WHERE project_id='p' AND type='spore'`).run();
    }
    fixture.sqlite.close();
    expect(unrelated[0]).toEqual(unrelated[1]);
    expect(history[0]).toBe(history[1]);
    expect(seeks[0]).toEqual(seeks[1]);
    for (const samples of [safety, stale]) {
      expect(samples[0]).toBeLessThanOrEqual(3_000);
      expect(samples[1]).toBeLessThanOrEqual(3_000);
      expect(Math.abs(samples[1]! - samples[0]!)).toBeLessThanOrEqual(2);
    }
    expect(totals[0]).toBeLessThanOrEqual(100);
    expect(totals[1]).toBeLessThanOrEqual(100);
    expect(Math.abs(totals[1]! - totals[0]!)).toBeLessThanOrEqual(2);
  } finally { await mf.dispose(); }
}, 60_000);
