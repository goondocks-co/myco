import { normalizedVector, validateStoredVectors, validateVectorReferences, validateVectorQuery, vectorNamespace, type StoredVector, type VectorMetadata, type VectorStore } from '../../core/embedding/vectors.js';
import { sha256Hex } from '../../hash.js';

type MetadataFilter = Record<string, { $eq?: string; $gte?: number; $lte?: number }>;

/** The platform binding carries only the vector operations the adapter consumes. */
export interface VectorIndex {
  upsert(vectors: Array<{ id: string; values: number[]; namespace: string; metadata: Record<string, string | number> }>): Promise<unknown>;
  query(values: number[], options: { namespace: string; topK: number; returnValues: false; returnMetadata: 'none'; filter?: MetadataFilter }): Promise<{ matches: Array<{ id: string; score: number }> }>;
  getByIds(ids: string[]): Promise<Array<{ id: string; values: ArrayLike<number>; namespace?: string; metadata?: Record<string, unknown> }>>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

/** Queries and reads use the model partition; mutations prove their source identity. */
export function cloudflareVectorStore(index: VectorIndex): VectorStore {
  const store: VectorStore = {
    async upsert(scope, vectors) {
      if (vectors.length === 0) return;
      await validateStoredVectors(scope, vectors);
      const namespace = await vectorNamespace(scope);
      await index.upsert(await Promise.all(vectors.map(async (v) => ({ id: v.id, values: normalizedVector(v.values), namespace,
        metadata: { ...v.metadata, session_id: await sha256Hex(v.metadata.session_id), session_id_raw: v.metadata.session_id },
      }))));
    },
    async query(scope, query) {
      validateVectorQuery(query);
      const filter: MetadataFilter = Object.fromEntries(await Promise.all(Object.entries(query.filters ?? {}).map(async ([key, value]) => [key,
        typeof value === 'string' ? { $eq: key === 'session_id' ? await sha256Hex(value) : value } : {
          ...(value.gte === undefined ? {} : { $gte: value.gte }),
          ...(value.lte === undefined ? {} : { $lte: value.lte }),
        },
      ])));
      const result = await index.query(normalizedVector(query.values), {
        namespace: await vectorNamespace(scope), topK: query.topK, returnValues: false, returnMetadata: 'none',
        ...(Object.keys(filter).length === 0 ? {} : { filter }),
      });
      return result.matches.filter((v) => v.score >= (query.minScore ?? -1));
    },
    async get(scope, ids) {
      if (ids.length === 0) return [];
      const namespace = await vectorNamespace(scope);
      return (await index.getByIds(ids)).filter((v) => v.namespace === namespace)
        .map((v): StoredVector => {
          if (v.metadata === undefined) throw new Error('stored vector has no source metadata');
          return { id: v.id, values: Array.from(v.values), metadata: { ...v.metadata, session_id: v.metadata.session_id_raw } as unknown as VectorMetadata };
        });
    },
    async delete(scope, references) {
      if (references.length === 0) return;
      await validateVectorReferences(scope, references);
      await index.deleteByIds(references.map((v) => v.id));
    },
  };
  return store;
}
