import { describe, expect, test } from 'bun:test';
import { hasEmbeddingWork } from '@myco-server-worker/core/embedding/work.js';
import { calibrationPending, hubnessQueries } from '@myco-server-worker/core/embedding/hubness.js';
import { retirementQueries, retiringReceipt, sourceSelectionQuery, unwrittenQuery } from '@myco-server-worker/core/embedding/selection.js';
import { INPUT_REFUSAL_RETRY_MS, embeddingFailureWakeAt, reconcileEmbedding } from '@myco-server-worker/core/embedding/reconcile.js';
import { VECTOR_DELETE_CONFIRM_MS, VECTOR_DELETE_RETRY_MS } from '@myco-server-worker/core/embedding/provider.js';
import { WORK_SWEEP_MIN_MS, WORK_SWEEP_PAGE, WORK_SWEEP_CONTINUE_MS } from '@myco-server-worker/core/embedding/work-state.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { withEmbeddingStore } from './helpers/embedding-work-store.js';
import { memoryBlobStore, sqliteEnv } from './helpers/fixtures.js';
import { cloudflareVectorStore } from '@myco-server-worker/platform/cloudflare/vectors.js';
import { indexFixture } from './helpers/vector-index.js';
import { cloudflareEmbeddingProvider, EMBEDDING_MODEL } from '@myco-server-worker/platform/cloudflare/embedding.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { stampRequest } from '@myco-server-worker/core/activity.js';
import { lastTaskEntryQueries, hasLiveTaskRunAnywhere } from '@myco-server-worker/core/runs.js';
import { runTick, tickPacer } from '@myco-server-worker/core/tick.js';

const NOW = 10 ** 12;
const MODEL = 'm';
const REFERENCE_DELETION_DUE = `((r.ready >= 0 AND (r.model_key NOT IN (SELECT value FROM json_each(?)) OR NOT EXISTS
  (SELECT 1 FROM embedding_sources s WHERE s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision)))
  OR (r.ready = -1 AND r.updated_at <= ?) OR (r.ready = -2 AND r.updated_at <= ?))`;
const referenceDeletionBinds = (retained: readonly string[], now: number): [string, number, number] =>
  [JSON.stringify([...new Set(retained)]), now - VECTOR_DELETE_CONFIRM_MS, now - VECTOR_DELETE_RETRY_MS];
const plan = (db: RelationalStore, id: string, content = 'body') => db.prepare(`INSERT INTO plans
  (project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
  VALUES('p',?,'session','event','machine',?,'hash','active',1,1,'token',1)`).bind(id, content);
const receipts = (db: RelationalStore) => db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
  SELECT project_id,'m',record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='p'`);

describe.each(['native', 'D1'])('%s embedding work journal', (target) => {
  test('deep-idle safety pages permit sleep and chain through the real scheduler', async () => {
    await withEmbeddingStore(target, async (db) => {
      const model = JSON.stringify(['cloudflare', EMBEDDING_MODEL]);
      const fixture = sqliteEnv();
      let allowDispatch = false, launched = 0;
      try {
        for (let i = 0; i < WORK_SWEEP_PAGE * 3; i++) await plan(db, `plan-${String(i).padStart(4, '0')}`).run();
        await db.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
          SELECT project_id,?,record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='p'`).bind(model).run();
        expect(await hasEmbeddingWork(db, 'p', model, NOW)).toBe(false);
        await db.prepare("UPDATE embedding_work_state SET sweep_at=? WHERE project_id='p'").bind(NOW).run();
        const env = { ...fixture.serverEnv, db, origin: 'http://local.invalid',
          vectors: cloudflareVectorStore(indexFixture()),
          embeddingProvider: async () => cloudflareEmbeddingProvider({ run: async () => ({ data: [[1, 0]] }) }, { model: EMBEDDING_MODEL, modelKey: model }),
          harnessLaunch: async () => {
            if (!allowDispatch) throw new Error('caught-up safety sweep dispatched an embedding run');
            launched++;
          },
        };
        const pacer = tickPacer();
        const first = await runTick(env, NOW, { wake: 'clock', pacer });
        expect(first.state).toBe('sleep');
        expect(first.heldBy).toBe('embedding:sweep');
        expect(first.jobs.find((job) => job.name === 'embedding-reconcile')).toMatchObject({ changed: 0, more: true, failed: null });
        expect(first.jobs.every((job) => job.failed === null)).toBe(true);
        expect(first.nextWakeMs).toBe(WORK_SWEEP_CONTINUE_MS);
        expect(first.drainOnly).toBe(false);
        const early = await runTick(env, NOW + 2_000, { wake: 'clock', pacer });
        expect(early.jobs).toEqual([]);
        expect(early.nextWakeMs).toBe(WORK_SWEEP_CONTINUE_MS - 2_000);
        const next = await runTick(env, NOW + WORK_SWEEP_CONTINUE_MS, { wake: 'clock', pacer });
        expect(next.drainOnly).toBe(true);
        expect(next.jobs).toEqual([{ name: 'embedding-reconcile', changed: 0, failed: null, more: true, continueAfterMs: WORK_SWEEP_CONTINUE_MS }]);
        expect(next.nextWakeMs).toBe(WORK_SWEEP_CONTINUE_MS);
        expect(next.drained).toBe(0);
        await plan(db, 'new-pending').run();
        allowDispatch = true;
        const promoted = await runTick(env, NOW + WORK_SWEEP_CONTINUE_MS * 2, { wake: 'clock', pacer });
        expect(promoted.drainOnly).toBe(false);
        expect(promoted.state).toBe('idle');
        expect(promoted.jobs.find((job) => job.name === 'embedding-reconcile')).toMatchObject({ changed: 1, failed: null });
        expect(launched).toBe(1);
      } finally { fixture.sqlite.close(); }
    });
  }, 30_000);

  test('sleep never dispatches when the embedding idle hold is disabled', async () => {
    await withEmbeddingStore(target, async (db) => {
      const fixture = sqliteEnv();
      try {
        await plan(db, 'pending').run();
        await settingsWriter(db).setLeaf('embedding.prevent_deep_sleep', false, 'operator', NOW);
        await stampRequest(db, NOW - 40 * 60_000);
        const model = JSON.stringify(['cloudflare', EMBEDDING_MODEL]);
        const env = { ...fixture.serverEnv, db, origin: 'http://local.invalid', vectors: cloudflareVectorStore(indexFixture()),
          embeddingProvider: async () => cloudflareEmbeddingProvider({ run: async () => ({ data: [[1, 0]] }) }, { model: EMBEDDING_MODEL, modelKey: model }),
          harnessLaunch: async () => { throw new Error('sleep dispatched embedding'); },
        };
        const report = await runTick(env, NOW, { wake: 'clock' });
        expect(report.state).toBe('sleep');
        expect(report.jobs.find((job) => job.name === 'embedding-reconcile')).toMatchObject({ changed: 0, more: false, failed: null });
        expect(await db.prepare('SELECT 1 FROM agent_runs').first()).toBeNull();
      } finally { fixture.sqlite.close(); }
    });
  }, 30_000);

  test('a concurrent source batch cannot be acknowledged by a drain that read an older revision', async () => {
    await withEmbeddingStore(target, async (db) => {
      await plan(db, 'initial').run();
      await receipts(db).run();
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW)).toBe(false);
      await db.prepare("UPDATE embedding_work_state SET revision=revision+1 WHERE project_id='p' AND kind='embedding'").run();
      const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const observe = (sql: string, statement: PreparedStatement): PreparedStatement => ({
        first: <T,>() => statement.first<T>(),
        all: <T,>() => statement.all<T>(),
        bind: (...values) => observe(sql, statement.bind(...values)),
        run: async () => {
          if (sql.startsWith('UPDATE embedding_work_state SET revision=revision+1,checked_revision')) {
            reached.resolve();
            await release.promise;
          }
          return statement.run();
        },
      });
      const draining: RelationalStore = { prepare: (sql) => observe(sql, db.prepare(sql)), batch: (statements) => db.batch(statements) };
      const pending = hasEmbeddingWork(draining, 'p', MODEL, NOW);
      await reached.promise;
      try { await db.batch([plan(db, 'concurrent')]); } finally { release.resolve(); }
      expect(await pending).toBe(true);
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW)).toBe(true);
      const context = { db, blobs: memoryBlobStore(), vectors: cloudflareVectorStore(indexFixture()), provider: { modelKey: MODEL, embed: async () => [1, 0] } };
      expect((await reconcileEmbedding(context, 'p', NOW)).processed).toBe(1);
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW)).toBe(false);
    });
  }, 30_000);

  test('source writes and journal invalidation commit or roll back together', async () => {
    await withEmbeddingStore(target, async (db) => {
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW)).toBe(false);
      const state = () => db.prepare("SELECT revision,checked_revision,pending FROM embedding_work_state WHERE project_id='p' AND kind='embedding'").first();
      const before = await state();
      await expect(db.batch([plan(db, 'rolled-back'), db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','duplicate',1)")])).rejects.toThrow();
      expect(await state()).toEqual(before);
      expect(await db.prepare("SELECT 1 FROM plans WHERE project_id='p' AND plan_key='rolled-back'").first()).toBeNull();
      await db.batch([plan(db, 'committed')]);
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW)).toBe(true);
      await receipts(db).run();
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW)).toBe(false);
      await db.prepare("UPDATE plans SET content='changed' WHERE project_id='p' AND plan_key='committed'").run();
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW)).toBe(true);
    });
  }, 30_000);

  test('a bounded safety sweep reaches late missing work, repairs its marker and backs off when idle', async () => {
    await withEmbeddingStore(target, async (db) => {
      for (let i = 0; i < WORK_SWEEP_PAGE * 2 + 1; i++) await plan(db, `plan-${String(i).padStart(4, '0')}`).run();
      await receipts(db).run();
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW)).toBe(false);
      await db.prepare("DELETE FROM embedding_receipts WHERE project_id='p' AND id=?").bind(`plan-${String(WORK_SWEEP_PAGE * 2).padStart(4, '0')}`).run();
      await db.prepare("UPDATE embedding_work_state SET checked_revision=revision,pending=0,wake_at=NULL,sweep_cursor=NULL,sweep_at=? WHERE project_id='p'").bind(NOW + WORK_SWEEP_MIN_MS).run();
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW + WORK_SWEEP_MIN_MS - 1)).toBe(false);
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW + WORK_SWEEP_MIN_MS)).toBe(false);
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW + WORK_SWEEP_MIN_MS + WORK_SWEEP_CONTINUE_MS)).toBe(false);
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW + WORK_SWEEP_MIN_MS + WORK_SWEEP_CONTINUE_MS * 2)).toBe(true);
      await receipts(db).run();
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW + WORK_SWEEP_MIN_MS + WORK_SWEEP_CONTINUE_MS * 2)).toBe(false);
      const row = await db.prepare("SELECT pending,checked_revision,revision,sweep_at FROM embedding_work_state WHERE project_id='p' AND kind='embedding'")
        .first<{ pending: number; checked_revision: number; revision: number; sweep_at: number }>();
      expect(row?.pending).toBe(0);
      expect(row?.checked_revision).toBe(row?.revision);
      expect(row!.sweep_at).toBeGreaterThan(NOW + WORK_SWEEP_MIN_MS + WORK_SWEEP_CONTINUE_MS * 2);
    });
  }, 30_000);

  test('hubness membership drift is repaired by the safety sweep', async () => {
    await withEmbeddingStore(target, async (db) => {
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
      for (const id of ['one', 'two']) await db.prepare("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES('p',?,'agent','body','decision',1)").bind(id).run();
      await receipts(db).run();
      await db.prepare("INSERT INTO embedding_hubness_members(project_id,model_key,id,n,vector) SELECT project_id,model_key,id,1,'AACAPw==' FROM embedding_receipts WHERE project_id='p'").run();
      expect(await calibrationPending(db, 'p', MODEL, NOW)).toBe(false);
      await db.prepare("UPDATE embedding_hubness_members SET n=9 WHERE project_id='p' AND id='two'").run();
      await db.prepare("UPDATE embedding_work_state SET checked_revision=revision,pending=0 WHERE project_id='p'").run();
      expect(await calibrationPending(db, 'p', MODEL, NOW)).toBe(false);
      expect(await calibrationPending(db, 'p', MODEL, NOW + WORK_SWEEP_MIN_MS)).toBe(false);
      expect(await calibrationPending(db, 'p', MODEL, NOW + WORK_SWEEP_MIN_MS + WORK_SWEEP_CONTINUE_MS)).toBe(true);
    });
  }, 30_000);

  test('failure expiry and deletion confirmation wake clean markers at their indexed deadlines', async () => {
    await withEmbeddingStore(target, async (db) => {
      await plan(db, 'refused').run();
      await db.prepare(`INSERT INTO embedding_source_failures(project_id,type,record_id,model_key,revision,reason,recorded_at)
        SELECT project_id,type,record_id,'m',revision,'refused',? FROM embedding_versions WHERE project_id='p'`).bind(NOW).run();
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW)).toBe(false);
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW + INPUT_REFUSAL_RETRY_MS - 1)).toBe(false);
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW + INPUT_REFUSAL_RETRY_MS)).toBe(true);
      await receipts(db).run();
      await db.prepare("UPDATE embedding_receipts SET ready=-1,updated_at=? WHERE project_id='p'").bind(NOW).run();
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW)).toBe(false);
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW + VECTOR_DELETE_CONFIRM_MS - 1)).toBe(false);
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW + VECTOR_DELETE_CONFIRM_MS)).toBe(true);
    });
  }, 30_000);

  test('selection arms use source identities and the new composite indexes', async () => {
    await withEmbeddingStore(target, async (db) => {
      const queries = [...retirementQueries('p', [MODEL], NOW), unwrittenQuery('p', MODEL, NOW),
        ...[false, true].map((stale) => sourceSelectionQuery('p', 'plan', MODEL, NOW, stale)), ...hubnessQueries('p', MODEL, NOW), ...lastTaskEntryQueries({ projectId: 'p' }, 'embedding-reconcile')];
      const plans: string[] = [];
      for (const { sql, binds } of queries) {
        const details = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map((row) => row.detail).join('\n');
        plans.push(details);
        expect(details).not.toMatch(/SCAN (embedding_versions|embedding_receipts|embedding_hubness_members|sessions|spores|plans|skill_records)\b/);
        expect(details).not.toMatch(/AUTOMATIC/);
        if (sql.includes('FROM agent_runs')) {
          expect(details).toMatch(/idx_agent_runs_(skipped_)?entry/);
          expect(details).not.toContain('TEMP B-TREE');
        }
        if (sql.includes('ORDER BY s.attempted_at')) expect(details).toContain('idx_embedding_versions_attempt');
        if (sql.includes('r.ready < 0')) expect(details).toContain('idx_embedding_receipts_delete');
        if (sql.includes('r.ready >= 0')) expect(details).toContain('idx_embedding_receipts_retire');
      }
      expect(plans.some((details) => details.includes('idx_embedding_receipts_spore'))).toBe(true);
      expect(plans.some((details) => details.includes('idx_embedding_receipts_identity'))).toBe(true);
      let liveSql = '';
      await hasLiveTaskRunAnywhere({ ...db, prepare: (sql) => { liveSql = sql; return db.prepare(sql); } }, 'embedding-reconcile');
      const livePlan = await db.prepare(`EXPLAIN QUERY PLAN ${liveSql}`).bind('embedding-reconcile').all<{ detail: string }>();
      expect(livePlan.results.map((row) => row.detail).join('\n')).toContain('idx_agent_runs_task_live');
      let failureSql = '';
      await embeddingFailureWakeAt({ ...db, prepare: (sql) => { failureSql = sql; return db.prepare(sql); } }, 'p', MODEL, NOW);
      const failurePlan = await db.prepare(`EXPLAIN QUERY PLAN ${failureSql}`).bind('p', MODEL, NOW - INPUT_REFUSAL_RETRY_MS).all<{ detail: string }>();
      expect(failurePlan.results.map((row) => row.detail).join('\n')).toContain('idx_embedding_failures_retry');
    });
  }, 30_000);

  test('split retirement arms select the same oldest eligible receipt as the compound predicate', async () => {
    await withEmbeddingStore(target, async (db) => {
      await plan(db, 'current').run();
      await receipts(db).run();
      const retained = [MODEL, JSON.stringify(['ollama', '\uE000', 'http://localhost:11434/api/embed']), JSON.stringify(['ollama', '\u{1F600}', 'http://localhost:11434/api/embed'])];
      for (const model of retained.slice(1)) await db.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
        SELECT project_id,?,id,type,record_id,revision,ready,updated_at FROM embedding_receipts WHERE project_id='p' AND model_key=?`).bind(model, MODEL).run();
      for (const [id, model, ready, updated] of [
        ['stale', MODEL, 1, 2], ['retired', 'old', 1, 3], ['sent', MODEL, -1, 4], ['failed', MODEL, -2, 5],
        ['\uE000', retained[1]!, 1, 1], ['\u{1F600}', retained[2]!, 1, 1],
      ] as const) {
        await db.prepare("INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at) VALUES('p',?,?,'plan','gone','gone',?,?)").bind(model, id, ready, updated).run();
      }
      for (let i = 0; i < 7; i++) {
        const legacy = await db.prepare(`SELECT r.id FROM embedding_receipts r WHERE r.project_id=? AND ${REFERENCE_DELETION_DUE} ORDER BY r.updated_at,r.id LIMIT 1`)
          .bind('p', ...referenceDeletionBinds(retained, NOW)).first<{ id: string }>();
        const selected = await retiringReceipt(db, 'p', retained, NOW);
        expect(selected?.id ?? null).toBe(legacy?.id ?? null);
        if (selected !== null) await db.prepare("DELETE FROM embedding_receipts WHERE project_id='p' AND model_key=? AND id=?").bind(selected.model_key, selected.id).run();
      }
    });
  }, 30_000);
});
