import { measuredStore } from './helpers/read-budget.js';
import { prepareEmbeddingDue } from '@myco-server-worker/db/embeddings/work.js';
import { describe, expect, test } from 'bun:test';
import { hasEmbeddingWork } from '@myco-server-worker/core/embedding/work.js';
import { calibrationPending } from '@myco-server-worker/core/embedding/hubness.js';
import { retiringReceipt } from '@myco-server-worker/core/embedding/selection.js';
import { INPUT_REFUSAL_RETRY_MS, embeddingFailureWakeAt, reconcileEmbedding } from '@myco-server-worker/core/embedding/reconcile.js';
import { VECTOR_DELETE_CONFIRM_MS, VECTOR_DELETE_RETRY_MS } from '@myco-server-worker/core/embedding/provider.js';
/** Wakes well apart, as an idle Deployment's clock spaces them. */
const WAKE_GAP_MS = 5 * 60_000;
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { withEmbeddingStore } from './helpers/embedding-work-store.js';
import { memoryBlobStore, sqliteEnv } from './helpers/fixtures.js';
import { cloudflareVectorStore } from '@myco-server-worker/platform/cloudflare/vectors.js';
import { indexFixture } from './helpers/vector-index.js';
import { cloudflareEmbeddingProvider, EMBEDDING_MODEL } from '@myco-server-worker/platform/cloudflare/embedding.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { stampRequest } from '@myco-server-worker/core/activity.js';
import { lastTaskEntryAt, hasLiveTaskRunAnywhere } from '@myco-server-worker/core/runs.js';
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
/** Registers and initializes the model's work for the Project, as its first embedding step does. */
const initialized = async (db: RelationalStore, model = MODEL) => { while ((await prepareEmbeddingDue(db, 'p', model)).more); };
const receipts = (db: RelationalStore) => db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
  SELECT project_id,'m',record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='p'`);

describe.each(['native', 'D1'])('%s embedding work journal', (target) => {
  test('a caught-up Deployment sleeps without a sweep hold or continuation, and dispatches when a source arrives', async () => {
    await withEmbeddingStore(target, async (db) => {
      const model = JSON.stringify(['cloudflare', EMBEDDING_MODEL]);
      const fixture = sqliteEnv();
      let allowDispatch = false, launched = 0;
      try {
        for (let i = 0; i < 96; i++) await plan(db, `plan-${String(i).padStart(4, '0')}`).run();
        await db.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
          SELECT project_id,?,record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='p'`).bind(model).run();
        await initialized(db, model);
        expect(await hasEmbeddingWork(db, 'p', model, NOW)).toBe(false);
        const env = { ...fixture.serverEnv, db, origin: 'http://local.invalid',
          vectors: cloudflareVectorStore(indexFixture()),
          embeddingProvider: async () => cloudflareEmbeddingProvider({ run: async () => ({ data: [[1, 0]] }) }, { model: EMBEDDING_MODEL, modelKey: model }),
          harnessLaunch: async () => {
            if (!allowDispatch) throw new Error('a caught-up Deployment dispatched an embedding run');
            launched++;
          },
        };
        const pacer = tickPacer();
        for (const at of [NOW, NOW + WAKE_GAP_MS, NOW + WAKE_GAP_MS * 7]) {
          const report = await runTick(env, at, { wake: 'clock', pacer });
          expect(report.heldBy).not.toBe('embedding:sweep');
          expect(report.jobs.filter((job) => job.name === 'embedding-reconcile').every((job) => job.more === false && job.failed === null)).toBe(true);
        }
        await plan(db, 'new-pending').run();
        allowDispatch = true;
        const promoted = await runTick(env, NOW + WAKE_GAP_MS * 8, { wake: 'clock', pacer });
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
      await initialized(db);
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW)).toBe(false);
      await db.prepare("UPDATE embedding_work_state SET revision=revision+1 WHERE project_id='p' AND kind='embedding'").run();
      const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      // The drain parks at the commit that acknowledges the revision it read.
      const acknowledging = new WeakSet<PreparedStatement>();
      const draining: RelationalStore = {
        prepare: (sql) => {
          const statement = db.prepare(sql);
          if (!sql.startsWith('UPDATE embedding_work_state SET revision=revision+1,checked_revision')) return statement;
          return new Proxy(statement, { get: (target, key) => key === 'bind'
            ? (...values: unknown[]) => { const bound = target.bind(...values); acknowledging.add(bound); return bound; }
            : Reflect.get(target, key, target) });
        },
        batch: async (statements) => {
          if (statements.some((statement) => acknowledging.has(statement))) { reached.resolve(); await release.promise; }
          return db.batch(statements);
        },
      };
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
      await initialized(db);
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

  test('failure expiry and deletion confirmation wake clean markers at their indexed deadlines', async () => {
    await withEmbeddingStore(target, async (db) => {
      await plan(db, 'refused').run();
      await db.prepare(`INSERT INTO embedding_source_failures(project_id,type,record_id,model_key,revision,reason,recorded_at)
        SELECT project_id,type,record_id,'m',revision,'refused',? FROM embedding_versions WHERE project_id='p'`).bind(NOW).run();
      await initialized(db);
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

  test('selection, wake and admission reads stay constant as settled history grows', async () => {
    if (target !== 'D1') return;
    await withEmbeddingStore(target, async (db) => {
      const measured = measuredStore(db as unknown as Parameters<typeof measuredStore>[0]);
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
      const reads: Record<string, number[]> = {};
      const take = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
        measured.reset();
        const result = await fn();
        (reads[label] ??= []).push(measured.reads());
        return result;
      };
      for (const size of [200, 2_000]) {
        await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT OR IGNORE INTO plans
          (project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
          SELECT 'p',printf('plan-%06d',x),'session','event','machine','body','hash','active',1,1,'token',1 FROM n`).bind(size).run();
        await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT OR IGNORE INTO spores(project_id,id,agent_id,content,observation_type,created_at)
          SELECT 'p',printf('spore-%06d',x),'agent','body','decision',1 FROM n`).bind(size).run();
        await receipts(db).run();
        await db.prepare(`INSERT OR IGNORE INTO embedding_source_failures(project_id,type,record_id,model_key,revision,reason,recorded_at)
          SELECT project_id,type,record_id,'m',revision,'refused',1 FROM embedding_versions WHERE project_id='p' AND type='plan'`).run();
        await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT OR IGNORE INTO agent_runs(project_id,id,agent_id,task,status,started_at,queued_at)
          SELECT 'p',printf('run-%06d',x),'agent','embedding-reconcile','completed',x,x FROM n`).bind(size).run();
        expect(await take('retiring receipt', () => retiringReceipt(measured.db, 'p', [MODEL], NOW))).toBeNull();
        expect(await take('failure wake', () => embeddingFailureWakeAt(measured.db, 'p', MODEL, NOW))).toBeNull();
        expect(await take('last entry', () => lastTaskEntryAt(measured.db, { projectId: 'p' }, 'embedding-reconcile'))).toBe(size);
        expect(await take('live run', () => hasLiveTaskRunAnywhere(measured.db, 'embedding-reconcile'))).toBe(false);
      }
      console.info(`embedding selection rows read at 400 / 4,000 settled sources: ${JSON.stringify(reads)}`);
      for (const [label, [small, large]] of Object.entries(reads)) {
        expect({ label, large }).toEqual({ label, large: small });
        expect(large).toBeLessThanOrEqual(16);
      }
    });
  }, 60_000);

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
