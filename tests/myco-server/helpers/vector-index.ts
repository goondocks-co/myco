import type { VectorIndex } from '../../../packages/myco-server/src/platform/cloudflare/vectors.js';
import { cosineSimilarity } from '../../../packages/myco-server/src/core/embedding/vectors.js';

/**
 * With `deferred`, every mutation is acknowledged and queued, and `apply()` applies the queue in order, as Vectorize
 * applies its mutation log after acknowledging each call. Reads see only applied mutations.
 */
export function indexFixture(): VectorIndex;
export function indexFixture(options: { deferred: true }): VectorIndex & { apply(): void; deleted: string[][] };
export function indexFixture({ deferred = false } = {}): VectorIndex & { apply(): void; deleted: string[][] } {
  const rows = new Map<string, Parameters<VectorIndex['upsert']>[0][number]>();
  const log: Array<() => void> = [];
  const deleted: string[][] = [];
  const mutate = (change: () => void) => { if (deferred) log.push(change); else change(); };
  return {
    deleted,
    apply: () => { for (const change of log.splice(0)) change(); },
    upsert: async (vectors) => { const held = [...vectors]; mutate(() => { for (const v of held) rows.set(v.id, v); }); },
    query: async (values, options) => ({ matches: [...rows.values()]
      .filter((v) => v.namespace === options.namespace && Object.entries(options.filter ?? {}).every(([key, raw]) => {
        const filter = raw as { $eq?: string; $gte?: number; $lte?: number };
        const held = v.metadata[key];
        return (filter.$eq === undefined || held === filter.$eq)
          && (filter.$gte === undefined || typeof held === 'number' && held >= filter.$gte)
          && (filter.$lte === undefined || typeof held === 'number' && held <= filter.$lte);
      }))
      .map((v) => ({ id: v.id, score: cosineSimilarity(v.values, values) })).sort((a, b) => b.score - a.score).slice(0, options.topK) }),
    getByIds: async (ids) => {
      if (ids.length > 20) throw new Error('too many ids in payload; max id count is 20');
      return ids.flatMap((id) => rows.has(id) ? [rows.get(id)!] : []);
    },
    deleteByIds: async (ids) => {
      const held = [...ids];
      deleted.push(held);
      mutate(() => { for (const id of held) rows.delete(id); });
    },
  };
}
