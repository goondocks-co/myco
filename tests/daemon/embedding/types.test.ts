import { describe, it, expect } from 'vitest';
import {
  EMBEDDABLE_NAMESPACES,
  type EmbeddableNamespace,
  type DomainMetadata,
  type EmbeddingMetadata,
  type VectorSearchResult,
  type VectorStoreStats,
  type EmbeddingDetails,
  type ReconcileResult,
  type VectorStore,
  type ManagerEmbeddingProvider,
  type EmbeddableRecordSource,
} from '@myco/daemon/embedding/types';
import {
  EMBEDDING_INTERVAL_MS,
  EMBEDDING_BATCH_SIZE,
  CONTENT_HASH_ALGORITHM,
  SEARCH_SIMILARITY_THRESHOLD,
} from '@myco/constants';

describe('Embedding types', () => {
  describe('EMBEDDABLE_NAMESPACES', () => {
    it('contains exactly the four embeddable namespaces', () => {
      expect(EMBEDDABLE_NAMESPACES).toEqual(['sessions', 'spores', 'plans', 'artifacts']);
    });

    it('has length 4', () => {
      expect(EMBEDDABLE_NAMESPACES).toHaveLength(4);
    });
  });

  describe('type exports compile cleanly', () => {
    it('DomainMetadata fields are optional', () => {
      const empty: DomainMetadata = {};
      const full: DomainMetadata = {
        status: 'active',
        session_id: 'abc123',
        observation_type: 'gotcha',
        project_root: '/tmp',
      };
      expect(empty).toBeDefined();
      expect(full).toBeDefined();
    });

    it('EmbeddingMetadata has required and optional fields', () => {
      const meta: EmbeddingMetadata = {
        namespace: 'sessions',
        record_id: 'r1',
        model: 'nomic-embed-text',
        provider: 'ollama',
        dimensions: 768,
        content_hash: 'abc',
        embedded_at: Date.now(),
      };
      expect(meta.namespace).toBe('sessions');
    });

    it('VectorSearchResult has all required fields', () => {
      const result: VectorSearchResult = {
        id: 'v1',
        namespace: 'spores',
        similarity: 0.85,
        metadata: { foo: 'bar' },
      };
      expect(result.similarity).toBeGreaterThan(0);
    });

    it('VectorStoreStats shape is valid', () => {
      const stats: VectorStoreStats = {
        total: 100,
        by_namespace: { sessions: { embedded: 50, stale: 5 } },
        models: { 'nomic-embed-text': 100 },
      };
      expect(stats.total).toBe(100);
    });

    it('EmbeddingDetails extends VectorStoreStats', () => {
      const details: EmbeddingDetails = {
        total: 100,
        by_namespace: {},
        models: {},
        pending: { sessions: 10 },
        provider: { name: 'ollama', model: 'nomic-embed-text', available: true },
      };
      expect(details.pending).toBeDefined();
      expect(details.provider.available).toBe(true);
    });

    it('ReconcileResult has required fields', () => {
      const result: ReconcileResult = {
        embedded: 5,
        orphans_cleaned: 2,
        duration_ms: 1234,
      };
      expect(result.embedded).toBe(5);
    });

    // Interface types are verified at compile time — these type assertions
    // ensure the interfaces are importable and structurally sound.
    it('VectorStore interface is importable', () => {
      const _check: VectorStore | undefined = undefined;
      expect(_check).toBeUndefined();
    });

    it('ManagerEmbeddingProvider interface is importable', () => {
      const _check: ManagerEmbeddingProvider | undefined = undefined;
      expect(_check).toBeUndefined();
    });

    it('EmbeddableRecordSource interface is importable', () => {
      const _check: EmbeddableRecordSource | undefined = undefined;
      expect(_check).toBeUndefined();
    });

    it('EmbeddableNamespace type is a union of the namespace strings', () => {
      const ns: EmbeddableNamespace = 'sessions';
      expect(EMBEDDABLE_NAMESPACES).toContain(ns);
    });
  });
});

describe('Embedding constants', () => {
  it('EMBEDDING_INTERVAL_MS is positive', () => {
    expect(EMBEDDING_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('EMBEDDING_INTERVAL_MS is 30 seconds', () => {
    expect(EMBEDDING_INTERVAL_MS).toBe(30_000);
  });

  it('EMBEDDING_BATCH_SIZE is positive', () => {
    expect(EMBEDDING_BATCH_SIZE).toBeGreaterThan(0);
  });

  it('EMBEDDING_BATCH_SIZE is 10', () => {
    expect(EMBEDDING_BATCH_SIZE).toBe(10);
  });

  it('CONTENT_HASH_ALGORITHM is sha256', () => {
    expect(CONTENT_HASH_ALGORITHM).toBe('sha256');
  });

  it('SEARCH_SIMILARITY_THRESHOLD is between 0 and 1', () => {
    expect(SEARCH_SIMILARITY_THRESHOLD).toBeGreaterThan(0);
    expect(SEARCH_SIMILARITY_THRESHOLD).toBeLessThan(1);
  });
});
