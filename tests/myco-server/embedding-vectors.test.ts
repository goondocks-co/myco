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
