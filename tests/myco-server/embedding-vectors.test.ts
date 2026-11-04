import { PLATFORM_RECONCILIATION_MATRICES } from './helpers/reconciliation-cases.js';
import { indexFixture } from './helpers/vector-index.js';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { sqliteVectorStore } from '../../packages/myco-server/src/platform/bun/vectors.js';
import { cloudflareVectorStore } from '../../packages/myco-server/src/platform/cloudflare/vectors.js';
import { vectorId, type VectorMetadata, type VectorScope, type StoredVector } from '../../packages/myco-server/src/core/embedding/vectors.js';

configureSqliteLibrary();
const scope = { projectId: 'project-a', modelKey: 'model-a' };
async function vector(id: string, values: number[], metadata: Partial<VectorMetadata> = {}, partition: VectorScope = scope): Promise<StoredVector> {
  const meta: VectorMetadata = { type: 'spore', record_id: id, revision: 'one', status: 'active', session_id: 'session-a', created_at: 1000, observation_type: 'decision', release_state: 'draft', release_confidence: 'high', ...metadata };
  return { id: await vectorId(partition, meta.type, id, meta.revision), values, metadata: meta };
}

test('Cloudflare reads a full hubness page and retries a failed later provider read', async () => {
  const index = indexFixture();
  const rows = await Promise.all(Array.from({ length: 50 }, (_, i) => vector(`page-${i}`, [1, 0])));
  const getByIds = index.getByIds;
  let fail = false;
  index.getByIds = async (ids) => {
    if (fail && ids.includes(rows[30].id)) throw new Error('provider unavailable');
    return getByIds(ids);
  };
  const store = cloudflareVectorStore(index);
  const foreign = await vector('foreign', [1, 0], {}, { ...scope, projectId: 'other' });
  await store.upsert(scope, rows);
  await store.upsert({ ...scope, projectId: 'other' }, [foreign]);
  const ids = [...rows.map((row) => row.id), foreign.id, 'missing'];
  expect((await store.get(scope, ids)).map((row) => row.id)).toEqual(rows.map((row) => row.id));
  fail = true;
  await expect(store.get(scope, ids)).rejects.toThrow('provider unavailable');
  fail = false;
  expect((await store.get(scope, ids)).map((row) => row.metadata.record_id)).toEqual(rows.map((row) => row.metadata.record_id));
});


for (const target of ['sqlite-vec', 'vectorize-contract'] as const) {
  describe(target, () => {
    test('scopes reads and mutations, and filters before ranking and limiting', async () => {
      const db = new Database(':memory:');
      try {
        const store = target === 'sqlite-vec' ? sqliteVectorStore(db) : cloudflareVectorStore(indexFixture());
        const closest = await vector('closest', [1, 0], { status: 'archived' });
        const eligible = await vector('eligible', [0.8, 0.6], { created_at: 2000 });
        await store.upsert(scope, [closest, eligible]);
        const other = { ...scope, projectId: 'project-b' };
        expect(await store.query(other, { values: [1, 0], topK: 10 })).toEqual([]);
        expect(await store.query({ ...scope, modelKey: 'model-b' }, { values: [1, 0], topK: 10 })).toEqual([]);
        const hits = await store.query(scope, { values: [1, 0], topK: 1, filters: { status: 'active', created_at: { gte: 1500, lte: 2500 } } });
        expect(hits.map((h) => h.id)).toEqual([eligible.id]);
        expect(hits[0].score).toBeCloseTo(0.8, 5);
        const reference = { id: eligible.id, type: eligible.metadata.type, recordId: eligible.metadata.record_id, revision: eligible.metadata.revision };
        await expect(store.delete(other, [reference])).rejects.toThrow('vector ID');
        expect(await store.get(other, [eligible.id])).toEqual([]);
        expect((await store.get(scope, [eligible.id])).length).toBe(1);
        await expect(store.upsert(other, [eligible])).rejects.toThrow('vector ID');
        await store.delete(scope, [reference]);
        expect(await store.get(scope, [eligible.id])).toEqual([]);
      } finally { db.close(); }
    });
    test('rejects invalid vectors before mutating the batch', async () => {
      const db = new Database(':memory:');
      try {
        const store = target === 'sqlite-vec' ? sqliteVectorStore(db) : cloudflareVectorStore(indexFixture());
        const valid = await vector('valid', [1, 0]);
        await expect(store.upsert(scope, [valid, await vector('invalid', [NaN])])).rejects.toThrow('finite');
        expect(await store.get(scope, [valid.id])).toEqual([]);
        await expect(store.query(scope, { values: [0, 0], topK: 1 })).rejects.toThrow('nonzero');
        await expect(store.query(scope, { values: [1], topK: 101 })).rejects.toThrow('topK');
      } finally { db.close(); }
    });
  });
}

test('native vector content-key matrix covers delivery order, replay, clearing and transactional faults', async () => {
  expect(PLATFORM_RECONCILIATION_MATRICES['platform/bun/vectors.ts#upsert']).toEqual(['content-key']);
  const old = await vector('same-record', [1, 0], { revision: 'old' });
  const latest = await vector('same-record', [0, 1], { revision: 'new' });
  for (const order of [[old, latest], [latest, old]]) {
    const db = new Database(':memory:');
    try {
      const store = sqliteVectorStore(db);
      expect(await store.get(scope, [old.id, latest.id])).toEqual([]);
      for (const row of order) await store.upsert(scope, [row]);
      await store.upsert(scope, order);
      expect((await store.get(scope, [old.id, latest.id])).map(row => row.id).sort()).toEqual([old.id, latest.id].sort());
      const ref = (row: StoredVector) => ({ id: row.id, type: row.metadata.type, recordId: row.metadata.record_id, revision: row.metadata.revision });
      await store.delete(scope, [ref(old), ref(latest)]);
      await store.delete(scope, [ref(old)]);
      expect(await store.get(scope, [old.id, latest.id])).toEqual([]);
      db.exec("CREATE TRIGGER fault BEFORE INSERT ON local_vectors WHEN NEW.metadata_json LIKE '%new%' BEGIN SELECT RAISE(ABORT, 'vector fault'); END");
      await expect(store.upsert(scope, [old, latest])).rejects.toThrow('vector fault');
      expect(await store.get(scope, [old.id, latest.id])).toEqual([]);
      db.exec('DROP TRIGGER fault');
      await store.upsert(scope, [old, latest]);
      expect((await store.get(scope, [old.id, latest.id])).length).toBe(2);
    } finally { db.close(); }
  }
});
