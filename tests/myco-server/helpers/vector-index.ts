import type { VectorIndex } from '../../../packages/myco-server/src/platform/cloudflare/vectors.js';
import { cosineSimilarity } from '../../../packages/myco-server/src/core/embedding/vectors.js';

export function indexFixture(): VectorIndex {
  const rows = new Map<string, Parameters<VectorIndex['upsert']>[0][number]>();
  return {
    upsert: async (vectors) => { for (const v of vectors) rows.set(v.id, v); },
    query: async (values, options) => ({ matches: [...rows.values()]
      .filter((v) => v.namespace === options.namespace && Object.entries(options.filter ?? {}).every(([key, raw]) => {
        const filter = raw as { $eq?: string; $gte?: number; $lte?: number };
        const held = v.metadata[key];
        return (filter.$eq === undefined || held === filter.$eq)
          && (filter.$gte === undefined || typeof held === 'number' && held >= filter.$gte)
          && (filter.$lte === undefined || typeof held === 'number' && held <= filter.$lte);
      }))
      .map((v) => ({ id: v.id, score: cosineSimilarity(v.values, values) })).sort((a, b) => b.score - a.score).slice(0, options.topK) }),
    getByIds: async (ids) => ids.flatMap((id) => rows.has(id) ? [rows.get(id)!] : []),
    deleteByIds: async (ids) => { for (const id of ids) rows.delete(id); },
  };
}
