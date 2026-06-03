/**
 * Integration tests for corpus hubness statistics (per-spore distance
 * distribution) used by hubness-aware relevance selection.
 *
 * A "hub" vector sits near the corpus centroid and is therefore close to
 * everything — its mean distance to the rest of the corpus is the smallest.
 * computeHubnessStats must surface that so the selector can demote it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteVecVectorStore } from '@myco/daemon/embedding/sqlite-vec-store';
import { EMBEDDING_DIMENSIONS } from '@myco/db/schema';

const DIMS = EMBEDDING_DIMENSIONS;

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((x) => x / norm);
}

/** Base unit vector along `axis`, with a tiny perturbation along `perturbAxis`. */
function clusterVector(axis: number, perturbAxis: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[axis] = 1.0;
  v[perturbAxis] = 0.05;
  return normalize(v);
}

function meta(): Record<string, unknown> {
  return { model: 'test-model', provider: 'test-provider', content_hash: 'h', embedded_at: 1 };
}

describe('SqliteVecVectorStore.computeHubnessStats', () => {
  let store: SqliteVecVectorStore;

  beforeEach(() => {
    store = new SqliteVecVectorStore(); // :memory:
  });
  afterEach(() => store.close());

  it('assigns the smallest mean distance to a central hub vector', () => {
    // Cluster A near axis 0, cluster B near axis 5, hub between them.
    store.upsert('spores', 'a1', clusterVector(0, 10), meta());
    store.upsert('spores', 'a2', clusterVector(0, 11), meta());
    store.upsert('spores', 'a3', clusterVector(0, 12), meta());
    store.upsert('spores', 'b1', clusterVector(5, 20), meta());
    store.upsert('spores', 'b2', clusterVector(5, 21), meta());
    store.upsert('spores', 'b3', clusterVector(5, 22), meta());
    const hubVec = new Array<number>(DIMS).fill(0);
    hubVec[0] = 1.0;
    hubVec[5] = 1.0;
    store.upsert('spores', 'hub', normalize(hubVec), meta());

    const stats = store.computeHubnessStats('spores');
    const byId = new Map(stats.map((s) => [s.recordId, s]));

    expect(byId.size).toBe(7);
    const hubMean = byId.get('hub')!.mean;
    const otherMeans = [...byId.values()]
      .filter((s) => s.recordId !== 'hub')
      .map((s) => s.mean);

    // The hub is closer to the whole corpus than any cluster member is.
    for (const m of otherMeans) {
      expect(hubMean).toBeLessThan(m);
    }
    // Std is a real, non-negative number.
    expect(byId.get('hub')!.std).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty array for a namespace with fewer than two vectors', () => {
    store.upsert('spores', 'only', clusterVector(0, 10), meta());
    expect(store.computeHubnessStats('spores')).toEqual([]);
  });

  it('persists stats so search results carry neighbor distribution metadata', () => {
    store.upsert('spores', 'a1', clusterVector(0, 10), meta());
    store.upsert('spores', 'a2', clusterVector(0, 11), meta());
    const hubVec = new Array<number>(DIMS).fill(0);
    hubVec[0] = 1.0;
    hubVec[5] = 1.0;
    store.upsert('spores', 'hub', normalize(hubVec), meta());

    const stats = store.computeHubnessStats('spores');
    store.upsertHubnessStats('spores', stats);

    const results = store.search(clusterVector(0, 10), { namespace: 'spores', limit: 5, threshold: -1 });
    const hubResult = results.find((r) => r.id === 'hub');
    expect(hubResult).toBeDefined();
    expect(typeof hubResult!.metadata.neighbor_mean).toBe('number');
    expect(typeof hubResult!.metadata.neighbor_std).toBe('number');
  });
});
