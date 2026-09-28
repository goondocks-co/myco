import { afterEach, describe, expect, test } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { indexFixture } from './helpers/vector-index.js';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { sqliteVectorStore } from '../../packages/myco-server/src/platform/bun/vectors.js';
import { cloudflareVectorStore } from '../../packages/myco-server/src/platform/cloudflare/vectors.js';
import { reconcileEmbedding, RECEIPT, type EmbeddingStep } from '../../packages/myco-server/src/core/embedding/reconcile.js';
import { VECTOR_DELETE_CONFIRM_MS as C, VECTOR_DELETE_RETRY_MS as R, type EmbeddingProvider } from '../../packages/myco-server/src/core/embedding/provider.js';
import { vectorId, type VectorStore, type VectorType } from '../../packages/myco-server/src/core/embedding/vectors.js';
import { hasEmbeddingWork } from '../../packages/myco-server/src/core/embedding/jobs.js';

configureSqliteLibrary();
const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });

const T = 1_000_000_000;
const MODEL = 'test-model';
const SCOPE = { projectId: 'p', modelKey: MODEL };
type Target = 'sqlite-vec' | 'vectorize' | 'vectorize-deferred';

/** A pause point a test opens once; the next call through it waits until the test releases it. */
function pausePoint() {
  let armed = false;
  let release: (() => void) | null = null;
  const reached = Promise.withResolvers<void>();
  return {
    arm: () => { armed = true; },
    reached: reached.promise,
    release: () => release!(),
    pass: async () => {
      if (!armed) return;
      armed = false;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      reached.resolve();
      await wait;
    },
  };
}

function fixture(target: Target) {
  const f = sqliteEnv(); opened.push(f);
  const insert = (table: string, row: Record<string, unknown>) => f.sqlite.query(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row) as never[]);
  insert('projects', { project_id: 'p', name: 'project', created_at: 1 });
  insert('agents', { id: 'a', name: 'agent', source: 'built-in', enabled: 1, created_at: 1 });
  const spore = (id: string, content: string) => insert('spores', { project_id: 'p', id, agent_id: 'a', content, observation_type: 'decision', created_at: 1 });
  const index = target === 'vectorize-deferred' ? indexFixture({ deferred: true }) : null;
  const native: VectorStore = target === 'sqlite-vec' ? sqliteVectorStore(f.sqlite) : cloudflareVectorStore(index ?? indexFixture());
  const apply = () => index?.apply();
  const deletes: string[] = [];
  const upserts: string[] = [];
  const inEmbed = pausePoint();
  const inUpsert = pausePoint();
  let failDeletes = 0;
  const vectors: VectorStore = { ...native,
    upsert: async (scope, stored) => { await inUpsert.pass(); upserts.push(...stored.map((v) => v.id)); await native.upsert(scope, stored); },
    delete: async (scope, refs) => {
      deletes.push(...refs.map((r) => r.id));
      if (failDeletes > 0) { failDeletes--; throw new Error('vector store unavailable'); }
      await native.delete(scope, refs);
    } };
  const provider: EmbeddingProvider = { modelKey: MODEL, embed: async (text) => { await inEmbed.pass(); return text.includes('unrelated') ? [0, 1] : [1, 0]; } };
  const context = { db: f.db, blobs: f.bucket, vectors, provider };
  const step = (now: number) => reconcileEmbedding(context, 'p', now);
  /** Steps until a step processes nothing, applying queued vector mutations after each. */
  const settle = async (now: number): Promise<EmbeddingStep['phase'][]> => {
    const phases: EmbeddingStep['phase'][] = [];
    for (let i = 0; i < 200; i++) {
      const { phase, processed } = await step(now);
      apply();
      phases.push(phase);
      if (processed === 0) return phases;
    }
    throw new Error(`embedding did not settle: ${phases.slice(-5).join(',')}`);
  };
  const receipts = () => f.sqlite.query('SELECT record_id, ready, updated_at FROM embedding_receipts ORDER BY record_id, ready').all() as Array<{ record_id: string; ready: number; updated_at: number }>;
  const receiptIds = () => (f.sqlite.query('SELECT id FROM embedding_receipts ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
  const stored = async () => (await native.query(SCOPE, { values: [1, 1], topK: 100 })).map((h) => h.id).sort();
  const work = (now: number) => hasEmbeddingWork(f.db, 'p', MODEL, now);
  const held = async (id: string) => (await native.get(SCOPE, [id])).length === 1;
  const receiptOf = (record: string) => (f.sqlite.query(`SELECT r.id FROM embedding_receipts r JOIN embedding_versions v
    ON v.project_id = r.project_id AND v.type = r.type AND v.record_id = r.record_id AND v.revision = r.revision WHERE r.record_id = ?`).get(record) as { id: string }).id;
  return { ...f, insert, spore, index, native, apply, vectors, deletes, upserts, inEmbed, inUpsert, failDeletes: (n: number) => { failDeletes = n; },
    context, step, settle, receipts, receiptIds, stored, work, held, receiptOf };
}

/** Three indexed spores, then one edited so its previous revision's vector is an orphan. */
async function withOrphan(target: Target) {
  const f = fixture(target);
  for (const [id, content] of [['one', 'architecture'], ['two', 'architecture'], ['three', 'unrelated']]) f.spore(id, content);
  expect(await f.settle(T)).toContain('settled');
  expect(await f.work(T)).toBe(false);
  const old = f.receiptOf('one');
  f.sqlite.run("UPDATE spores SET content = 'architecture, revised' WHERE id = 'one'");
  expect(await f.work(T)).toBe(true);
  return { ...f, old };
}

describe.each(['sqlite-vec', 'vectorize'] as const)('%s: deletion receipts', (target) => {
  test('a sent delete is confirmed one window later, then the job stays quiet however far the clock advances', async () => {
    const f = await withOrphan(target);
    expect(await f.settle(T)).toContain('orphans');
    expect(await f.held(f.old)).toBe(false);
    expect(f.receipts().filter((r) => r.ready < 0)).toEqual([{ record_id: 'one', ready: RECEIPT.deletionSent, updated_at: T }]);
    expect(await f.work(T + C - 1)).toBe(false);
    expect(await f.work(T + C)).toBe(true);
    expect(await f.settle(T + C)).toEqual(['orphans', 'settled']);
    expect(f.receipts().map((r) => [r.record_id, r.ready])).toEqual([['one', 1], ['three', 1], ['two', 1]]);
    expect(f.sqlite.query('SELECT hubness_count FROM embedding_cursors').get()).toEqual({ hubness_count: 3 });
    for (const now of [T + C, T + R, T + R + 1, T + 10 * R]) expect(await f.work(now)).toBe(false);
    expect(await f.step(T + 10 * R)).toEqual({ phase: 'settled', processed: 0 });
    expect(f.deletes).toEqual([f.old, f.old]);
    expect(await f.stored()).toEqual(f.receiptIds());
  });

  test('a delete that fails backs off for the retry window, then is sent again and retired', async () => {
    const f = await withOrphan(target);
    expect((await f.step(T)).phase).toBe('stale');
    f.failDeletes(1);
    await expect(f.step(T)).rejects.toThrow('vector store unavailable');
    expect(f.receipts().filter((r) => r.ready < 0)).toEqual([{ record_id: 'one', ready: RECEIPT.deletionFailed, updated_at: T }]);
    expect(await f.held(f.old)).toBe(true);
    expect(await f.settle(T)).not.toContain('orphans');
    expect(await f.work(T + C)).toBe(false);
    expect(await f.work(T + R - 1)).toBe(false);
    expect(await f.work(T + R)).toBe(true);
    expect(await f.step(T + R)).toEqual({ phase: 'orphans', processed: 1 });
    expect(await f.held(f.old)).toBe(false);
    expect(f.receipts().every((r) => r.ready === RECEIPT.ready)).toBe(true);
    expect(f.deletes).toEqual([f.old, f.old]);
    expect(await f.work(T + 10 * R)).toBe(false);
  });

  test('receipts already claimed for deletion are confirmed and retired once due, with no manual repair', async () => {
    const f = fixture(target);
    f.spore('one', 'architecture');
    f.spore('two', 'unrelated');
    await f.settle(T);
    const leftover = async (type: VectorType, record: string, updatedAt: number, stored: boolean) => {
      const id = await vectorId(SCOPE, type, record, `gone-${record}`);
      f.insert('embedding_receipts', { project_id: 'p', model_key: MODEL, id, type, record_id: record, revision: `gone-${record}`, ready: RECEIPT.deletionSent, updated_at: updatedAt });
      if (stored) await f.native.upsert(SCOPE, [{ id, values: [1, 0], metadata: { type, record_id: record, revision: `gone-${record}`, status: 'active',
        session_id: '', created_at: 1, observation_type: '', release_state: '', release_confidence: '' } }]);
      return id;
    };
    const stamped = T - 60 * 60 * 1000;
    const kept = await leftover('spore', 'still-stored', stamped, true);
    for (const [type, record] of [['plan', 'plan-1'], ['session', 'session-1'], ['spore', 'spore-1'], ['spore', 'spore-2']] as const) await leftover(type, record, stamped, false);
    await leftover('spore', 'just-sent', T, false);
    expect(await f.work(T)).toBe(true);
    expect((await f.settle(T)).filter((p) => p === 'orphans')).toHaveLength(5);
    expect(f.receipts().map((r) => [r.record_id, r.ready])).toEqual([['just-sent', RECEIPT.deletionSent], ['one', 1], ['two', 1]]);
    expect(await f.held(kept)).toBe(false);
    expect(await f.work(T + C - 1)).toBe(false);
    expect(await f.settle(T + C)).toEqual(['orphans', 'settled']);
    expect(f.receipts().map((r) => r.record_id)).toEqual(['one', 'two']);
    expect(await f.work(T + 10 * R)).toBe(false);
  });

  test('a source write parked in the provider call is abandoned once its receipt is claimed for deletion', async () => {
    const f = await withOrphan(target);
    f.inEmbed.arm();
    const parked = f.step(T);
    await f.inEmbed.reached;
    const second = f.receiptOf('one');
    f.sqlite.run("UPDATE spores SET content = 'architecture, revised again' WHERE id = 'one'");
    expect(await f.settle(T)).toContain('orphans');
    expect(f.receipts().filter((r) => r.ready < 0).map((r) => r.record_id)).toEqual(['one', 'one']);
    f.inEmbed.release();
    expect(await parked).toEqual({ phase: 'stale', processed: 0 });
    expect(f.upserts).not.toContain(second);
    expect(await f.held(second)).toBe(false);
    expect(await f.settle(T + C)).toContain('orphans');
    expect(await f.stored()).toEqual(f.receiptIds());
    expect(f.receipts().map((r) => [r.record_id, r.ready])).toEqual([['one', 1], ['three', 1], ['two', 1]]);
    expect(await f.work(T + 10 * R)).toBe(false);
  });

  test('a source write parked in the vector write lands after the first delete, and the confirmation removes it', async () => {
    const f = await withOrphan(target);
    f.inUpsert.arm();
    const parked = f.step(T);
    await f.inUpsert.reached;
    const second = f.receiptOf('one');
    f.sqlite.run("UPDATE spores SET content = 'architecture, revised again' WHERE id = 'one'");
    expect(await f.settle(T)).toContain('orphans');
    f.inUpsert.release();
    expect(await parked).toEqual({ phase: 'stale', processed: 1 });
    expect(await f.held(second)).toBe(true);
    expect(f.receipts().filter((r) => r.ready < 0).map((r) => r.record_id)).toEqual(['one', 'one']);
    expect(await f.work(T + C - 1)).toBe(false);
    expect(await f.settle(T + C)).toContain('orphans');
    expect(await f.held(second)).toBe(false);
    expect(await f.stored()).toEqual(f.receiptIds());
    expect(await f.work(T + 10 * R)).toBe(false);
  });
});

describe('vectorize: mutations applied after the call returns', () => {
  test('a delete applied inside the confirmation window is retired at its confirmation', async () => {
    const f = await withOrphan('vectorize-deferred');
    expect((await f.step(T)).phase).toBe('stale');
    f.apply();
    expect(await f.step(T)).toEqual({ phase: 'orphans', processed: 1 });
    expect(await f.held(f.old)).toBe(true);
    f.apply();
    expect(await f.work(T + C - 1)).toBe(false);
    expect(await f.step(T + C)).toEqual({ phase: 'orphans', processed: 1 });
    expect(f.receipts().every((r) => r.ready === RECEIPT.ready)).toBe(true);
    expect(await f.work(T + 10 * R)).toBe(false);
  });

  test('a delete still unapplied at its confirmation is sent again and backs off for the retry window', async () => {
    const f = await withOrphan('vectorize-deferred');
    expect((await f.step(T)).phase).toBe('stale');
    f.apply();
    expect((await f.step(T)).phase).toBe('orphans');
    expect(await f.step(T + C)).toEqual({ phase: 'orphans', processed: 1 });
    expect(f.index!.deleted).toEqual([[f.old], [f.old]]);
    expect(f.receipts().filter((r) => r.ready < 0)).toEqual([{ record_id: 'one', ready: RECEIPT.deletionFailed, updated_at: T + C }]);
    expect(await f.work(T + C + R - 1)).toBe(false);
    f.apply();
    expect(await f.work(T + C + R)).toBe(true);
    expect(await f.step(T + C + R)).toEqual({ phase: 'orphans', processed: 1 });
    expect(await f.held(f.old)).toBe(false);
    expect(f.receipts().every((r) => r.ready === RECEIPT.ready)).toBe(true);
    expect(await f.work(T + 10 * R)).toBe(false);
  });

  test('a write still queued when its receipt is retired is removed by the delete queued after it', async () => {
    const f = await withOrphan('vectorize-deferred');
    expect((await f.step(T)).phase).toBe('stale');
    const second = f.receiptOf('one');
    expect(await f.held(second)).toBe(false);
    f.sqlite.run("UPDATE spores SET content = 'architecture, revised again' WHERE id = 'one'");
    expect((await f.step(T)).phase).toBe('stale');
    expect(await f.step(T)).toEqual({ phase: 'orphans', processed: 1 });
    expect(await f.step(T)).toEqual({ phase: 'orphans', processed: 1 });
    expect(await f.step(T + C)).toEqual({ phase: 'orphans', processed: 1 });
    expect(await f.step(T + C)).toEqual({ phase: 'orphans', processed: 1 });
    expect(f.receipts().filter((r) => r.ready < 0)).toEqual([{ record_id: 'one', ready: RECEIPT.deletionFailed, updated_at: T + C }]);
    expect(f.receiptIds()).not.toContain(second);
    f.apply();
    expect(await f.held(second)).toBe(false);
    expect(await f.settle(T + C + R)).toContain('orphans');
    expect(await f.stored()).toEqual(f.receiptIds());
    expect(await f.work(T + 10 * R)).toBe(false);
  });
});
