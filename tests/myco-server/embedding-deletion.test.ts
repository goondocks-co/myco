import { afterEach, describe, expect, test } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { indexFixture } from './helpers/vector-index.js';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { sqliteVectorStore } from '../../packages/myco-server/src/platform/bun/vectors.js';
import { cloudflareVectorStore } from '../../packages/myco-server/src/platform/cloudflare/vectors.js';
import { reconcileEmbedding, RECEIPT, type EmbeddingContext, type EmbeddingStep } from '../../packages/myco-server/src/core/embedding/reconcile.js';
import { VECTOR_DELETE_CONFIRM_MS as C, VECTOR_DELETE_RETRY_MS as R, type EmbeddingProvider } from '../../packages/myco-server/src/core/embedding/provider.js';
import { vectorId, type VectorStore, type VectorType } from '../../packages/myco-server/src/core/embedding/vectors.js';
import { hasEmbeddingWork } from '../../packages/myco-server/src/core/embedding/jobs.js';

configureSqliteLibrary();
const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });

const T = 1_000_000_000;
const MODEL = 'test-model';
const OTHER_MODEL = 'other-model';
const SCOPE = { projectId: 'p', modelKey: MODEL };
type Target = 'sqlite-vec' | 'vectorize' | 'vectorize-deferred';

/** A pause point a test opens once; the next matching call through it waits until the test releases it. */
function pausePoint() {
  let armed: ((ids: string[]) => boolean) | null = null;
  let release: (() => void) | null = null;
  const reached = Promise.withResolvers<void>();
  return {
    arm: (match: (ids: string[]) => boolean = () => true) => { armed = match; },
    reached: reached.promise,
    release: () => release!(),
    pass: async (ids: string[] = []) => {
      if (armed === null || !armed(ids)) return;
      armed = null;
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
  const inDelete = pausePoint();
  const hang = { upsert: false, delete: false };
  const never = new Promise<never>(() => {});
  let failDeletes = 0;
  const vectors: VectorStore = { ...native,
    upsert: async (scope, stored) => {
      await inUpsert.pass(stored.map((v) => v.id));
      if (hang.upsert) return never;
      upserts.push(...stored.map((v) => v.id));
      await native.upsert(scope, stored);
    },
    delete: async (scope, refs) => {
      await inDelete.pass(refs.map((r) => r.id));
      if (hang.delete) return never;
      deletes.push(...refs.map((r) => r.id));
      if (failDeletes > 0) { failDeletes--; throw new Error('vector store unavailable'); }
      await native.delete(scope, refs);
    } };
  const model = { key: MODEL };
  const provider: EmbeddingProvider = { get modelKey() { return model.key; }, embed: async (text) => { await inEmbed.pass(); return text.includes('unrelated') ? [0, 1] : [1, 0]; } };
  const context: EmbeddingContext = { db: f.db, blobs: f.bucket, vectors, provider };
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
  const work = (now: number) => hasEmbeddingWork(f.db, 'p', model.key, now);
  /** Every stored vector has a receipt, and every indexed receipt has its vector, under both models. */
  const inconsistencies = async () => {
    const found: string[] = [];
    for (const modelKey of [MODEL, OTHER_MODEL]) {
      const rows = f.sqlite.query('SELECT id, ready FROM embedding_receipts WHERE model_key = ?').all(modelKey) as Array<{ id: string; ready: number }>;
      const vectorIds = (await native.query({ projectId: 'p', modelKey }, { values: [1, 1], topK: 100 })).map((h) => h.id);
      for (const id of vectorIds) if (!rows.some((r) => r.id === id)) found.push(`${modelKey}: vector without receipt`);
      for (const r of rows) if (r.ready === RECEIPT.ready && !vectorIds.includes(r.id)) found.push(`${modelKey}: indexed receipt without vector`);
    }
    return found;
  };
  const held = async (id: string) => (await native.get(SCOPE, [id])).length === 1;
  const receiptOf = (record: string) => (f.sqlite.query(`SELECT r.id FROM embedding_receipts r JOIN embedding_versions v
    ON v.project_id = r.project_id AND v.type = r.type AND v.record_id = r.record_id AND v.revision = r.revision WHERE r.record_id = ?`).get(record) as { id: string }).id;
  return { ...f, insert, spore, index, native, apply, vectors, deletes, upserts, inEmbed, inUpsert, inDelete, hang, model, inconsistencies, failDeletes: (n: number) => { failDeletes = n; },
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

describe.each(['sqlite-vec', 'vectorize'] as const)('%s: claims are never taken back', (target) => {
  /** Three spores indexed under the first model, then the model switched to another. */
  async function switched() {
    const f = fixture(target);
    for (const [id, content] of [['one', 'architecture'], ['two', 'architecture'], ['three', 'unrelated']]) f.spore(id, content);
    await f.settle(T);
    f.model.key = OTHER_MODEL;
    return f;
  }
  const receiptsOf = (f: ReturnType<typeof fixture>, modelKey: string) =>
    (f.sqlite.query('SELECT ready FROM embedding_receipts WHERE model_key = ? ORDER BY ready').all(modelKey) as Array<{ ready: number }>).map((r) => r.ready);

  test('a model switched away and back waits for its claimed receipts to retire, then indexes afresh', async () => {
    const f = await switched();
    await f.settle(T);
    expect(receiptsOf(f, MODEL)).toEqual([-1, -1, -1]);
    f.model.key = MODEL;
    expect(await f.settle(T + 1)).not.toContain('stale');
    expect(receiptsOf(f, MODEL)).toEqual([-1, -1, -1]);
    expect(receiptsOf(f, OTHER_MODEL)).toEqual([-1, -1, -1]);
    expect(await f.work(T + C - 1)).toBe(false);
    expect(await f.work(T + C)).toBe(true);
    const phases = await f.settle(T + C);
    expect(phases.filter((p) => p === 'orphans')).toHaveLength(3);
    expect(phases.filter((p) => p === 'stale')).toHaveLength(3);
    expect(receiptsOf(f, MODEL)).toEqual([1, 1, 1]);
    await f.settle(T + 1 + C);
    expect(receiptsOf(f, OTHER_MODEL)).toEqual([]);
    expect(await f.inconsistencies()).toEqual([]);
    expect(f.sqlite.query('SELECT hubness_model, hubness_count FROM embedding_cursors').get()).toEqual({ hubness_model: MODEL, hubness_count: 3 });
    expect(await f.work(T + 10 * R)).toBe(false);
  });

  test('a model switched back while a claimed receipt\'s delete is parked leaves the receipt claimed until it retires', async () => {
    const f = await switched();
    f.inDelete.arm();
    const parked = f.settle(T);
    await f.inDelete.reached;
    expect(receiptsOf(f, MODEL)).toEqual([-1, 1, 1]);
    f.model.key = MODEL;
    await f.settle(T);
    expect(receiptsOf(f, MODEL)).toEqual([-1, 1, 1]);
    f.inDelete.release();
    await parked;
    expect(await f.inconsistencies()).toEqual([]);
    for (const now of [T + C, T + C + R, T + 3 * R]) await f.settle(now);
    expect(receiptsOf(f, MODEL)).toEqual([1, 1, 1]);
    expect(receiptsOf(f, OTHER_MODEL)).toEqual([]);
    expect(await f.inconsistencies()).toEqual([]);
    expect(await f.work(T + 10 * R)).toBe(false);
  });

  test('a write that lands while its receipt\'s delete is parked leaves the receipt claimed', async () => {
    const f = fixture(target);
    for (const [id, content] of [['one', 'architecture'], ['two', 'architecture'], ['three', 'unrelated']]) f.spore(id, content);
    await f.settle(T);
    f.sqlite.run("UPDATE spores SET content = 'architecture, revised' WHERE id = 'one'");
    f.inUpsert.arm();
    const writing = f.step(T);
    await f.inUpsert.reached;
    const second = f.receiptOf('one');
    f.model.key = OTHER_MODEL;
    f.inDelete.arm((ids) => ids.includes(second));
    const deleting = f.settle(T);
    await f.inDelete.reached;
    f.inUpsert.release();
    expect(await writing).toEqual({ phase: 'stale', processed: 1 });
    expect(f.sqlite.query('SELECT ready FROM embedding_receipts WHERE id = ?').get(second)).toEqual({ ready: RECEIPT.deletionSent });
    f.inDelete.release();
    await deleting;
    expect(await f.inconsistencies()).toEqual([]);
    f.model.key = MODEL;
    for (const now of [T + C, T + 2 * C, T + C + R, T + 3 * R]) await f.settle(now);
    expect(await f.inconsistencies()).toEqual([]);
    expect(receiptsOf(f, MODEL)).toEqual([1, 1, 1]);
    expect(await f.work(T + 10 * R)).toBe(false);
  });
});

describe.each(['sqlite-vec', 'vectorize'] as const)('%s: vector calls are bounded', (target) => {
  test('a vector write that never settles fails its step at the bound and leaves its receipt journaled', async () => {
    const f = await withOrphan(target);
    f.context.vectorWriteTimeoutMs = 20;
    f.hang.upsert = true;
    await expect(f.step(T)).rejects.toThrow('vector write did not settle within 20 ms');
    expect(f.sqlite.query('SELECT ready FROM embedding_receipts WHERE id = ?').get(f.receiptOf('one'))).toEqual({ ready: RECEIPT.journaled });
    f.hang.upsert = false;
    expect(await f.work(T)).toBe(true);
    await f.settle(T);
    await f.settle(T + C);
    expect(f.receipts().every((r) => r.ready === RECEIPT.ready)).toBe(true);
    expect(await f.stored()).toEqual(f.receiptIds());
  });

  test('a vector write that returns after its receipt is retired claims the vector for deletion again', async () => {
    const f = await withOrphan(target);
    f.inUpsert.arm();
    const parked = f.step(T);
    await f.inUpsert.reached;
    const second = f.receiptOf('one');
    f.sqlite.run("UPDATE spores SET content = 'architecture, revised again' WHERE id = 'one'");
    await f.settle(T);
    await f.settle(T + C);
    expect(f.receiptIds()).not.toContain(second);
    f.inUpsert.release();
    expect(await parked).toEqual({ phase: 'stale', processed: 1 });
    expect(f.sqlite.query('SELECT ready, updated_at FROM embedding_receipts WHERE id = ?').get(second)).toEqual({ ready: RECEIPT.deletionSent, updated_at: T });
    await f.settle(T + C);
    expect(await f.held(second)).toBe(false);
    expect(await f.inconsistencies()).toEqual([]);
    expect(await f.work(T + 10 * R)).toBe(false);
  });

  test('a delete that never settles fails its step at the bound and backs off like a failed delete', async () => {
    const f = await withOrphan(target);
    expect((await f.step(T)).phase).toBe('stale');
    f.context.vectorWriteTimeoutMs = 20;
    f.hang.delete = true;
    await expect(f.step(T)).rejects.toThrow('vector delete did not settle within 20 ms');
    expect(f.receipts().filter((r) => r.ready < 0)).toEqual([{ record_id: 'one', ready: RECEIPT.deletionFailed, updated_at: T }]);
    f.hang.delete = false;
    expect(await f.work(T + R - 1)).toBe(false);
    expect(await f.step(T + R)).toEqual({ phase: 'orphans', processed: 1 });
    expect(f.receipts().every((r) => r.ready === RECEIPT.ready)).toBe(true);
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
