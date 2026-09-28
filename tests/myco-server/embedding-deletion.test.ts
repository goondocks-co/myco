import { afterEach, describe, expect, test } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { indexFixture } from './helpers/vector-index.js';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { sqliteVectorStore } from '../../packages/myco-server/src/platform/bun/vectors.js';
import { cloudflareVectorStore } from '../../packages/myco-server/src/platform/cloudflare/vectors.js';
import { reconcileEmbedding, type EmbeddingStep } from '../../packages/myco-server/src/core/embedding/reconcile.js';
import { VECTOR_DELETE_RETRY_MS, type EmbeddingProvider } from '../../packages/myco-server/src/core/embedding/provider.js';
import { vectorId, type VectorStore, type VectorType } from '../../packages/myco-server/src/core/embedding/vectors.js';
import { hasEmbeddingWork } from '../../packages/myco-server/src/core/embedding/jobs.js';

configureSqliteLibrary();
const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });

const T = 1_000_000_000;
const MODEL = 'test-model';
type Target = 'sqlite-vec' | 'vectorize' | 'vectorize-deferred';

function fixture(target: Target) {
  const f = sqliteEnv(); opened.push(f);
  const insert = (table: string, row: Record<string, unknown>) => f.sqlite.query(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row) as never[]);
  insert('projects', { project_id: 'p', name: 'project', created_at: 1 });
  insert('agents', { id: 'a', name: 'agent', source: 'built-in', enabled: 1, created_at: 1 });
  const spore = (id: string, content: string) => insert('spores', { project_id: 'p', id, agent_id: 'a', content, observation_type: 'decision', created_at: 1 });
  const index = target === 'vectorize-deferred' ? indexFixture({ deferDeletes: true }) : null;
  const native: VectorStore = target === 'sqlite-vec' ? sqliteVectorStore(f.sqlite) : cloudflareVectorStore(index ?? indexFixture());
  const deletes: string[] = [];
  let failDeletes = 0;
  const vectors: VectorStore = { ...native, delete: async (scope, refs) => {
    deletes.push(...refs.map((r) => r.id));
    if (failDeletes > 0) { failDeletes--; throw new Error('vector store unavailable'); }
    await native.delete(scope, refs);
  } };
  const provider: EmbeddingProvider = { modelKey: MODEL, embed: async (text) => text.includes('unrelated') ? [0, 1] : [1, 0] };
  const context = { db: f.db, blobs: f.bucket, vectors, provider };
  const step = (now: number) => reconcileEmbedding(context, 'p', now);
  /** Steps until the index reports settled, returning each phase taken. */
  const settle = async (now: number): Promise<EmbeddingStep['phase'][]> => {
    const phases: EmbeddingStep['phase'][] = [];
    for (let i = 0; i < 200; i++) {
      const { phase } = await step(now);
      phases.push(phase);
      if (phase === 'settled') return phases;
    }
    throw new Error(`embedding did not settle: ${phases.slice(-5).join(',')}`);
  };
  const receipts = () => f.sqlite.query('SELECT record_id, ready, updated_at FROM embedding_receipts ORDER BY record_id, ready').all() as Array<{ record_id: string; ready: number; updated_at: number }>;
  const work = (now: number) => hasEmbeddingWork(f.db, 'p', MODEL, now);
  const held = async (id: string) => (await native.get({ projectId: 'p', modelKey: MODEL }, [id])).length === 1;
  return { ...f, insert, spore, index, native, vectors, deletes, failDeletes: (n: number) => { failDeletes = n; }, context, step, settle, receipts, work, held };
}

/** Three indexed spores, then one edited so its previous revision's vector is an orphan. */
async function withOrphan(target: Target) {
  const f = fixture(target);
  for (const [id, content] of [['one', 'architecture'], ['two', 'architecture'], ['three', 'unrelated']]) f.spore(id, content);
  await f.settle(T);
  expect(await f.work(T)).toBe(false);
  const old = (f.sqlite.query("SELECT id FROM embedding_receipts WHERE record_id = 'one'").get() as { id: string }).id;
  f.sqlite.run("UPDATE spores SET content = 'architecture, revised' WHERE id = 'one'");
  expect(await f.work(T)).toBe(true);
  return { ...f, old };
}

describe.each(['sqlite-vec', 'vectorize'] as const)('%s: a confirmed deletion retires its receipt', (target) => {
  test('the job goes quiet once the orphan is deleted and hubness settles, however far the clock advances', async () => {
    const f = await withOrphan(target);
    expect(await f.settle(T)).toContain('orphans');
    expect(await f.held(f.old)).toBe(false);
    expect(f.receipts().map((r) => [r.record_id, r.ready])).toEqual([['one', 1], ['three', 1], ['two', 1]]);
    expect(f.sqlite.query('SELECT hubness_count FROM embedding_cursors').get()).toEqual({ hubness_count: 3 });
    for (const now of [T, T + VECTOR_DELETE_RETRY_MS, T + VECTOR_DELETE_RETRY_MS + 1, T + 10 * VECTOR_DELETE_RETRY_MS]) {
      expect(await f.work(now)).toBe(false);
    }
    expect(await f.step(T + VECTOR_DELETE_RETRY_MS + 1)).toEqual({ phase: 'settled', processed: 0 });
    expect(f.deletes).toEqual([f.old]);
  });

  test('a failed delete backs off and is retried after the window', async () => {
    const f = await withOrphan(target);
    expect((await f.step(T)).phase).toBe('stale');
    f.failDeletes(1);
    await expect(f.step(T)).rejects.toThrow('vector store unavailable');
    expect(f.receipts().find((r) => r.record_id === 'one' && r.ready === -1)).toEqual({ record_id: 'one', ready: -1, updated_at: T });
    expect(await f.held(f.old)).toBe(true);
    expect(await f.settle(T)).not.toContain('orphans');
    expect(await f.work(T + VECTOR_DELETE_RETRY_MS - 1)).toBe(false);
    expect(await f.work(T + VECTOR_DELETE_RETRY_MS)).toBe(true);
    expect(await f.step(T + VECTOR_DELETE_RETRY_MS)).toEqual({ phase: 'orphans', processed: 1 });
    expect(await f.held(f.old)).toBe(false);
    expect(f.receipts().every((r) => r.ready === 1)).toBe(true);
    expect(f.deletes).toEqual([f.old, f.old]);
    expect(await f.work(T + 10 * VECTOR_DELETE_RETRY_MS)).toBe(false);
  });

  test('deletion receipts left at ready = -1 by an earlier release drain without manual repair', async () => {
    const f = fixture(target);
    f.spore('one', 'architecture');
    f.spore('two', 'unrelated');
    await f.settle(T);
    const scope = { projectId: 'p', modelKey: MODEL };
    const leftover = async (type: VectorType, record: string, updatedAt: number, stored: boolean) => {
      const id = await vectorId(scope, type, record, `gone-${record}`);
      f.insert('embedding_receipts', { project_id: 'p', model_key: MODEL, id, type, record_id: record, revision: `gone-${record}`, ready: -1, updated_at: updatedAt });
      if (stored) await f.native.upsert(scope, [{ id, values: [1, 0], metadata: { type, record_id: record, revision: `gone-${record}`, status: 'active',
        session_id: '', created_at: 1, observation_type: '', release_state: '', release_confidence: '' } }]);
      return id;
    };
    const stamped = T - 60 * 60 * 1000;
    const kept = await leftover('spore', 'still-stored', stamped, true);
    for (const [type, record] of [['plan', 'plan-1'], ['session', 'session-1'], ['spore', 'spore-1'], ['spore', 'spore-2']] as const) await leftover(type, record, stamped, false);
    expect(await f.work(T)).toBe(false);
    const due = stamped + VECTOR_DELETE_RETRY_MS;
    expect(await f.work(due)).toBe(true);
    const phases = await f.settle(due);
    expect(phases.filter((p) => p === 'orphans')).toHaveLength(5);
    expect(f.receipts().map((r) => [r.record_id, r.ready])).toEqual([['one', 1], ['two', 1]]);
    expect(await f.held(kept)).toBe(false);
    expect(await f.work(due + 10 * VECTOR_DELETE_RETRY_MS)).toBe(false);
  });
});

describe('vectorize: a deletion applied after the call returns', () => {
  test('keeps its receipt until a retry finds the vector gone, then retires it', async () => {
    const f = await withOrphan('vectorize-deferred');
    expect(await f.settle(T)).toContain('orphans');
    expect(await f.held(f.old)).toBe(true);
    expect(f.receipts().find((r) => r.ready === -1)).toEqual({ record_id: 'one', ready: -1, updated_at: T });
    expect(await f.work(T + VECTOR_DELETE_RETRY_MS - 1)).toBe(false);
    f.index!.applyDeletes();
    expect(await f.work(T + VECTOR_DELETE_RETRY_MS)).toBe(true);
    expect(await f.step(T + VECTOR_DELETE_RETRY_MS)).toEqual({ phase: 'orphans', processed: 1 });
    expect(f.receipts().every((r) => r.ready === 1)).toBe(true);
    expect(await f.work(T + 10 * VECTOR_DELETE_RETRY_MS)).toBe(false);
  });

  test('sends the delete again while the vector is still readable after the window', async () => {
    const f = await withOrphan('vectorize-deferred');
    await f.settle(T);
    expect(await f.step(T + VECTOR_DELETE_RETRY_MS)).toEqual({ phase: 'orphans', processed: 1 });
    expect(f.index!.deleted).toEqual([[f.old], [f.old]]);
    expect(f.receipts().find((r) => r.ready === -1)).toEqual({ record_id: 'one', ready: -1, updated_at: T + VECTOR_DELETE_RETRY_MS });
    expect(await f.work(T + VECTOR_DELETE_RETRY_MS + 1)).toBe(false);
    f.index!.applyDeletes();
    expect((await f.settle(T + 2 * VECTOR_DELETE_RETRY_MS)).filter((p) => p === 'orphans')).toHaveLength(1);
    expect(await f.held(f.old)).toBe(false);
    expect(await f.work(T + 10 * VECTOR_DELETE_RETRY_MS)).toBe(false);
  });
});
