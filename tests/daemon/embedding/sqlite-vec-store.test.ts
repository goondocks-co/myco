import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteVecVectorStore } from '@myco/daemon/embedding/sqlite-vec-store';
import { EMBEDDABLE_NAMESPACES } from '@myco/daemon/embedding/types';
import { EMBEDDING_DIMENSIONS } from '@myco/db/schema';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Number of dimensions used in test vectors (matches production default). */
const DIMS = EMBEDDING_DIMENSIONS; // 1024

/** Create a zero vector with a single axis set to 1.0 (unit vector along that axis). */
function unitVector(axis: number, dims = DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  v[axis] = 1.0;
  return v;
}

/** Create a vector with all components set to the same value, then normalize to unit length. */
function uniformVector(dims = DIMS): number[] {
  const val = 1.0 / Math.sqrt(dims);
  return new Array<number>(dims).fill(val);
}

/** Standard metadata for test upserts. */
function testMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'test-model',
    provider: 'test-provider',
    content_hash: 'hash-abc',
    embedded_at: 1700000000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SqliteVecVectorStore', () => {
  let store: SqliteVecVectorStore;

  beforeEach(() => {
    store = new SqliteVecVectorStore(); // :memory:
  });

  afterEach(() => {
    store.close();
  });

  // -------------------------------------------------------------------------
  // Constructor / schema
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates in-memory database without errors', () => {
      expect(store).toBeDefined();
    });

    it('can be created with explicit :memory: path', () => {
      const s = new SqliteVecVectorStore(':memory:');
      expect(s).toBeDefined();
      s.close();
    });
  });

  // -------------------------------------------------------------------------
  // upsert
  // -------------------------------------------------------------------------

  describe('upsert', () => {
    it('stores vector and metadata', () => {
      const vec = unitVector(0);
      store.upsert('sessions', 'rec-1', vec, testMeta());

      const ids = store.getEmbeddedIds('sessions');
      expect(ids).toContain('rec-1');

      const stats = store.stats('sessions');
      expect(stats.total).toBe(1);
      expect(stats.by_namespace['sessions']?.embedded).toBe(1);
      expect(stats.models['test-model']).toBe(1);
    });

    it('is idempotent — same id twice overwrites cleanly', () => {
      const vec1 = unitVector(0);
      const vec2 = unitVector(1);

      store.upsert('spores', 'rec-1', vec1, testMeta({ content_hash: 'hash-v1' }));
      store.upsert('spores', 'rec-1', vec2, testMeta({ content_hash: 'hash-v2' }));

      // Only one row should exist
      const ids = store.getEmbeddedIds('spores');
      expect(ids).toEqual(['rec-1']);

      // Stats should show exactly 1 embedding
      const stats = store.stats('spores');
      expect(stats.total).toBe(1);
    });

    it('validates namespace', () => {
      expect(() =>
        store.upsert('invalid_ns', 'rec-1', unitVector(0), testMeta()),
      ).toThrow(/Invalid namespace/);
    });

    it('works across multiple namespaces', () => {
      store.upsert('sessions', 's1', unitVector(0), testMeta());
      store.upsert('spores', 'sp1', unitVector(1), testMeta());
      store.upsert('plans', 'p1', unitVector(2), testMeta());
      store.upsert('artifacts', 'a1', unitVector(3), testMeta());

      const stats = store.stats();
      expect(stats.total).toBe(4);
      expect(Object.keys(stats.by_namespace)).toHaveLength(4);
    });

    it('stores metadata with default values when metadata is omitted', () => {
      store.upsert('sessions', 'rec-1', unitVector(0));
      const stats = store.stats('sessions');
      expect(stats.models['unknown']).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------

  describe('remove', () => {
    it('deletes from both vec table and metadata', () => {
      store.upsert('sessions', 'rec-1', unitVector(0), testMeta());
      expect(store.getEmbeddedIds('sessions')).toContain('rec-1');

      store.remove('sessions', 'rec-1');
      expect(store.getEmbeddedIds('sessions')).not.toContain('rec-1');

      const stats = store.stats('sessions');
      expect(stats.total).toBe(0);
    });

    it('is a silent no-op for non-existent ids', () => {
      // Should not throw
      store.remove('sessions', 'does-not-exist');
      expect(store.stats('sessions').total).toBe(0);
    });

    it('validates namespace', () => {
      expect(() => store.remove('bad_ns', 'rec-1')).toThrow(/Invalid namespace/);
    });
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  describe('clear', () => {
    beforeEach(() => {
      store.upsert('sessions', 's1', unitVector(0), testMeta());
      store.upsert('sessions', 's2', unitVector(1), testMeta());
      store.upsert('spores', 'sp1', unitVector(2), testMeta());
    });

    it('clears only the specified namespace', () => {
      const result = store.clear('sessions');
      expect(result.cleared).toBe(2);

      expect(store.getEmbeddedIds('sessions')).toEqual([]);
      expect(store.getEmbeddedIds('spores')).toEqual(['sp1']);
    });

    it('clears all namespaces when no namespace given', () => {
      const result = store.clear();
      expect(result.cleared).toBe(3);

      for (const ns of EMBEDDABLE_NAMESPACES) {
        expect(store.getEmbeddedIds(ns)).toEqual([]);
      }
    });

    it('returns zero when already empty', () => {
      store.clear();
      const result = store.clear();
      expect(result.cleared).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  describe('search', () => {
    beforeEach(() => {
      // Insert orthogonal unit vectors so cosine similarity is predictable:
      // - unitVector(0) · unitVector(0) = 1.0  (identical)
      // - unitVector(0) · unitVector(1) = 0.0  (orthogonal)
      store.upsert('sessions', 'axis-0', unitVector(0), testMeta());
      store.upsert('sessions', 'axis-1', unitVector(1), testMeta());
      store.upsert('spores', 'axis-2', unitVector(2), testMeta());
    });

    it('returns results ordered by similarity DESC', () => {
      // Query along axis 0 — should match axis-0 perfectly, axis-1 not at all
      const results = store.search(unitVector(0), { namespace: 'sessions' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe('axis-0');
      expect(results[0].similarity).toBeCloseTo(1.0, 2);
    });

    it('restricts results to specified namespace', () => {
      const results = store.search(unitVector(2), { namespace: 'spores' });
      expect(results.every((r) => r.namespace === 'spores')).toBe(true);
      expect(results[0].id).toBe('axis-2');
    });

    it('searches across all namespaces when no namespace given', () => {
      const results = store.search(unitVector(0));
      // Should include results from both sessions and spores
      const namespaces = new Set(results.map((r) => r.namespace));
      expect(namespaces.size).toBeGreaterThanOrEqual(1);
    });

    it('respects limit parameter', () => {
      // Add more vectors
      for (let i = 3; i < 8; i++) {
        store.upsert('sessions', `extra-${i}`, unitVector(i), testMeta());
      }
      const results = store.search(uniformVector(), {
        namespace: 'sessions',
        limit: 3,
      });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('excludes results below similarity threshold', () => {
      const results = store.search(unitVector(0), {
        namespace: 'sessions',
        threshold: 0.5,
      });
      // Only axis-0 should pass — axis-1 has similarity ~0 (orthogonal)
      for (const r of results) {
        expect(r.similarity).toBeGreaterThanOrEqual(0.5);
      }
    });

    it('returns empty array when no vectors exist', () => {
      const emptyStore = new SqliteVecVectorStore();
      const results = emptyStore.search(unitVector(0));
      expect(results).toEqual([]);
      emptyStore.close();
    });

    it('includes metadata in results', () => {
      const results = store.search(unitVector(0), { namespace: 'sessions' });
      const top = results[0];
      expect(top.metadata).toBeDefined();
      expect(top.metadata['model']).toBe('test-model');
      expect(top.metadata['provider']).toBe('test-provider');
    });

    it('filters by model when filters.model is set', () => {
      store.upsert('sessions', 'model-a', unitVector(3), testMeta({ model: 'alpha' }));
      store.upsert('sessions', 'model-b', unitVector(4), testMeta({ model: 'beta' }));

      const results = store.search(uniformVector(), {
        namespace: 'sessions',
        filters: { model: 'alpha' },
      });
      // Only model-a and the beforeEach entries with 'test-model' go through KNN,
      // but the JOIN filter keeps only model='alpha' rows.
      const models = results.map((r) => r.metadata['model']);
      expect(models.every((m) => m === 'alpha')).toBe(true);
      expect(results.some((r) => r.id === 'model-a')).toBe(true);
    });

    it('filters by provider when filters.provider is set', () => {
      store.upsert('sessions', 'prov-x', unitVector(5), testMeta({ provider: 'ollama' }));
      store.upsert('sessions', 'prov-y', unitVector(6), testMeta({ provider: 'openai' }));

      const results = store.search(uniformVector(), {
        namespace: 'sessions',
        filters: { provider: 'ollama' },
      });
      const providers = results.map((r) => r.metadata['provider']);
      expect(providers.every((p) => p === 'ollama')).toBe(true);
      expect(results.some((r) => r.id === 'prov-x')).toBe(true);
    });

    it('silently ignores unrecognized filter keys', () => {
      // 'bogus_key' is not in FILTERABLE_COLUMNS — should not cause an error
      // and should not affect results (acts as if no filter was given)
      const withBogus = store.search(unitVector(0), {
        namespace: 'sessions',
        filters: { bogus_key: 'whatever' },
      });
      const withoutFilter = store.search(unitVector(0), {
        namespace: 'sessions',
      });
      // Same results since the unrecognized key is ignored
      expect(withBogus.map((r) => r.id)).toEqual(withoutFilter.map((r) => r.id));
    });
  });

  // -------------------------------------------------------------------------
  // stats
  // -------------------------------------------------------------------------

  describe('stats', () => {
    it('returns correct per-namespace breakdown', () => {
      store.upsert('sessions', 's1', unitVector(0), testMeta({ model: 'model-a' }));
      store.upsert('sessions', 's2', unitVector(1), testMeta({ model: 'model-a' }));
      store.upsert('spores', 'sp1', unitVector(2), testMeta({ model: 'model-b' }));

      const stats = store.stats();
      expect(stats.total).toBe(3);
      expect(stats.by_namespace['sessions']?.embedded).toBe(2);
      expect(stats.by_namespace['spores']?.embedded).toBe(1);
      expect(stats.models['model-a']).toBe(2);
      expect(stats.models['model-b']).toBe(1);
    });

    it('returns stats for a single namespace', () => {
      store.upsert('sessions', 's1', unitVector(0), testMeta());
      store.upsert('spores', 'sp1', unitVector(1), testMeta());

      const stats = store.stats('sessions');
      expect(stats.total).toBe(1);
      expect(stats.by_namespace['sessions']?.embedded).toBe(1);
      expect(stats.by_namespace['spores']).toBeUndefined();
    });

    it('reports stale count based on model majority', () => {
      store.upsert('sessions', 's1', unitVector(0), testMeta({ model: 'current' }));
      store.upsert('sessions', 's2', unitVector(1), testMeta({ model: 'current' }));
      store.upsert('sessions', 's3', unitVector(2), testMeta({ model: 'old-model' }));

      const stats = store.stats('sessions');
      // 'current' is the majority (2 of 3), so stale = 1
      expect(stats.by_namespace['sessions']?.stale).toBe(1);
    });

    it('returns zero totals when empty', () => {
      const stats = store.stats();
      expect(stats.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getStaleIds
  // -------------------------------------------------------------------------

  describe('getStaleIds', () => {
    it('returns IDs where model does not match current', () => {
      store.upsert('sessions', 's1', unitVector(0), testMeta({ model: 'old-model' }));
      store.upsert('sessions', 's2', unitVector(1), testMeta({ model: 'current-model' }));
      store.upsert('sessions', 's3', unitVector(2), testMeta({ model: 'old-model' }));

      const stale = store.getStaleIds('sessions', 'current-model', 100);
      expect(stale).toContain('s1');
      expect(stale).toContain('s3');
      expect(stale).not.toContain('s2');
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        store.upsert('sessions', `s${i}`, unitVector(i), testMeta({ model: 'old' }));
      }
      const stale = store.getStaleIds('sessions', 'new', 3);
      expect(stale).toHaveLength(3);
    });

    it('returns empty array when all are current', () => {
      store.upsert('sessions', 's1', unitVector(0), testMeta({ model: 'current' }));
      const stale = store.getStaleIds('sessions', 'current', 100);
      expect(stale).toEqual([]);
    });

    it('validates namespace', () => {
      expect(() => store.getStaleIds('bogus', 'model', 10)).toThrow(
        /Invalid namespace/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // getEmbeddedIds
  // -------------------------------------------------------------------------

  describe('getEmbeddedIds', () => {
    it('returns all IDs in namespace', () => {
      store.upsert('plans', 'p1', unitVector(0), testMeta());
      store.upsert('plans', 'p2', unitVector(1), testMeta());

      const ids = store.getEmbeddedIds('plans');
      expect(ids).toHaveLength(2);
      expect(ids).toContain('p1');
      expect(ids).toContain('p2');
    });

    it('returns empty array for empty namespace', () => {
      const ids = store.getEmbeddedIds('artifacts');
      expect(ids).toEqual([]);
    });

    it('validates namespace', () => {
      expect(() => store.getEmbeddedIds('nope')).toThrow(/Invalid namespace/);
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('closes the database cleanly', () => {
      const s = new SqliteVecVectorStore();
      s.upsert('sessions', 'rec-1', unitVector(0), testMeta());
      s.close();

      // After close, operations should throw
      expect(() => s.getEmbeddedIds('sessions')).toThrow();
    });
  });
});
