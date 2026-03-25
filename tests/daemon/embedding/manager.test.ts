import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingManager } from '@myco/daemon/embedding/manager';
import type {
  VectorStore,
  ManagerEmbeddingProvider,
  EmbeddableRecordSource,
  VectorStoreStats,
  DomainMetadata,
} from '@myco/daemon/embedding/types';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

const MOCK_EMBEDDING = [0.1, 0.2, 0.3, 0.4];
const MOCK_MODEL = 'test-model';
const MOCK_PROVIDER_NAME = 'test-provider';
const MOCK_DIMENSIONS = 4;

function createMockVectorStore(): VectorStore & {
  upsert: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  stats: ReturnType<typeof vi.fn>;
  getStaleIds: ReturnType<typeof vi.fn>;
  getEmbeddedIds: ReturnType<typeof vi.fn>;
} {
  return {
    upsert: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn().mockReturnValue({ cleared: 0 }),
    search: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue({
      total: 0,
      by_namespace: {},
      models: {},
    } satisfies VectorStoreStats),
    getStaleIds: vi.fn().mockReturnValue([]),
    getEmbeddedIds: vi.fn().mockReturnValue([]),
  };
}

function createMockProvider(
  embedding: number[] | null = MOCK_EMBEDDING,
): ManagerEmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
  return {
    embed: vi.fn().mockResolvedValue(embedding),
    model: MOCK_MODEL,
    providerName: MOCK_PROVIDER_NAME,
    dimensions: MOCK_DIMENSIONS,
  };
}

function createMockRecordSource(): EmbeddableRecordSource & {
  getEmbeddableRows: ReturnType<typeof vi.fn>;
  getActiveRecordIds: ReturnType<typeof vi.fn>;
  getRecordContent: ReturnType<typeof vi.fn>;
  markEmbedded: ReturnType<typeof vi.fn>;
  clearEmbedded: ReturnType<typeof vi.fn>;
  clearAllEmbedded: ReturnType<typeof vi.fn>;
  getPendingCount: ReturnType<typeof vi.fn>;
} {
  return {
    getEmbeddableRows: vi.fn().mockReturnValue([]),
    getActiveRecordIds: vi.fn().mockReturnValue([]),
    getRecordContent: vi.fn().mockReturnValue([]),
    markEmbedded: vi.fn(),
    clearEmbedded: vi.fn(),
    clearAllEmbedded: vi.fn(),
    getPendingCount: vi.fn().mockReturnValue(0),
  };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmbeddingManager', () => {
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let provider: ReturnType<typeof createMockProvider>;
  let recordSource: ReturnType<typeof createMockRecordSource>;
  let logger: ReturnType<typeof createMockLogger>;
  let manager: EmbeddingManager;

  beforeEach(() => {
    vectorStore = createMockVectorStore();
    provider = createMockProvider();
    recordSource = createMockRecordSource();
    logger = createMockLogger();
    manager = new EmbeddingManager(vectorStore, provider, recordSource, logger);
  });

  // -------------------------------------------------------------------------
  // onContentWritten
  // -------------------------------------------------------------------------

  describe('onContentWritten', () => {
    const namespace = 'sessions';
    const id = 'session-abc123';
    const text = 'This is a test session summary';
    const metadata: DomainMetadata = { project_root: '/tmp/project' };

    it('calls provider.embed, vectorStore.upsert with correct metadata, and recordSource.markEmbedded', async () => {
      await manager.onContentWritten(namespace, id, text, metadata);

      expect(provider.embed).toHaveBeenCalledWith(text);
      expect(vectorStore.upsert).toHaveBeenCalledWith(
        namespace,
        id,
        MOCK_EMBEDDING,
        expect.objectContaining({
          model: MOCK_MODEL,
          provider: MOCK_PROVIDER_NAME,
          dimensions: MOCK_DIMENSIONS,
          domain_metadata: metadata,
        }),
      );
      // Verify content_hash is a sha256 hex string
      const upsertMeta = vectorStore.upsert.mock.calls[0][3] as Record<string, unknown>;
      expect(upsertMeta.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof upsertMeta.embedded_at).toBe('number');

      expect(recordSource.markEmbedded).toHaveBeenCalledWith(namespace, id);
      expect(logger.debug).toHaveBeenCalledWith('embedding', 'Vector stored', { namespace, id });
    });

    it('does NOT call upsert or markEmbedded when provider returns null', async () => {
      provider.embed.mockResolvedValue(null);

      await manager.onContentWritten(namespace, id, text, metadata);

      expect(vectorStore.upsert).not.toHaveBeenCalled();
      expect(recordSource.markEmbedded).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'embedding',
        'Provider unavailable, skipping embed',
        expect.objectContaining({ namespace, id }),
      );
    });

    it('catches provider.embed() throw without propagating', async () => {
      provider.embed.mockRejectedValue(new Error('network timeout'));

      await expect(manager.onContentWritten(namespace, id, text, metadata))
        .resolves.toBeUndefined();

      expect(vectorStore.upsert).not.toHaveBeenCalled();
      expect(recordSource.markEmbedded).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'embedding',
        'Failed to embed content',
        expect.objectContaining({ namespace, id }),
      );
    });

    it('catches vectorStore.upsert() throw without propagating', async () => {
      vectorStore.upsert.mockImplementation(() => {
        throw new Error('disk full');
      });

      await expect(manager.onContentWritten(namespace, id, text, metadata))
        .resolves.toBeUndefined();

      expect(recordSource.markEmbedded).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'embedding',
        'Failed to embed content',
        expect.objectContaining({ namespace, id }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // onStatusChanged
  // -------------------------------------------------------------------------

  describe('onStatusChanged', () => {
    const namespace = 'spores' as const;
    const id = 'spore-xyz789';

    it('removes vector and clears embedded for superseded status', () => {
      manager.onStatusChanged(namespace, id, 'superseded');

      expect(vectorStore.remove).toHaveBeenCalledWith(namespace, id);
      expect(recordSource.clearEmbedded).toHaveBeenCalledWith(namespace, id);
      expect(logger.debug).toHaveBeenCalledWith(
        'embedding',
        'Vector removed',
        expect.objectContaining({ namespace, id }),
      );
    });

    it('does NOT call remove for active status', () => {
      manager.onStatusChanged(namespace, id, 'active');

      expect(vectorStore.remove).not.toHaveBeenCalled();
      expect(recordSource.clearEmbedded).not.toHaveBeenCalled();
    });

    it('is idempotent — calling twice with same status is safe', () => {
      manager.onStatusChanged(namespace, id, 'archived');
      manager.onStatusChanged(namespace, id, 'archived');

      expect(vectorStore.remove).toHaveBeenCalledTimes(2);
      expect(recordSource.clearEmbedded).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // onRemoved
  // -------------------------------------------------------------------------

  describe('onRemoved', () => {
    it('calls vectorStore.remove for the namespace and id', () => {
      manager.onRemoved('plans', 'plan-abc');

      expect(vectorStore.remove).toHaveBeenCalledWith('plans', 'plan-abc');
      expect(logger.debug).toHaveBeenCalledWith(
        'embedding',
        'Vector removed',
        expect.objectContaining({ namespace: 'plans', id: 'plan-abc' }),
      );
    });

    it('handles non-existent vector without throwing', () => {
      // remove() is a no-op for missing vectors
      expect(() => manager.onRemoved('artifacts', 'no-such-id')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // reconcile
  // -------------------------------------------------------------------------

  describe('reconcile', () => {
    const BATCH_SIZE = 10;

    it('embeds missing rows, marks embedded, and returns correct counts', async () => {
      recordSource.getEmbeddableRows
        .mockImplementation((ns: string) => {
          if (ns === 'sessions') {
            return [
              { id: 's1', text: 'session text 1', metadata: {} },
              { id: 's2', text: 'session text 2', metadata: {} },
            ];
          }
          return [];
        });
      // No orphans
      vectorStore.getEmbeddedIds.mockReturnValue([]);
      recordSource.getActiveRecordIds.mockReturnValue([]);

      const result = await manager.reconcile(BATCH_SIZE);

      expect(result.embedded).toBe(2);
      expect(result.orphans_cleaned).toBe(0);
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);

      expect(provider.embed).toHaveBeenCalledTimes(2);
      expect(vectorStore.upsert).toHaveBeenCalledTimes(2);
      expect(recordSource.markEmbedded).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith(
        'embedding',
        'Reconcile cycle completed',
        expect.objectContaining({ embedded: 2, orphans_cleaned: 0 }),
      );
    });

    it('returns early with partial counts when provider becomes unavailable mid-batch', async () => {
      recordSource.getEmbeddableRows
        .mockImplementation((ns: string) => {
          if (ns === 'sessions') {
            return [
              { id: 's1', text: 'text1', metadata: {} },
              { id: 's2', text: 'text2', metadata: {} },
            ];
          }
          return [];
        });

      // First call succeeds, second returns null
      provider.embed
        .mockResolvedValueOnce(MOCK_EMBEDDING)
        .mockResolvedValueOnce(null);

      const result = await manager.reconcile(BATCH_SIZE);

      expect(result.embedded).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'embedding',
        'Provider unavailable during reconcile, returning partial progress',
        expect.objectContaining({ namespace: 'sessions', embedded: 1 }),
      );
    });

    it('detects and removes orphan vectors', async () => {
      // No missing rows
      recordSource.getEmbeddableRows.mockReturnValue([]);

      // sessions namespace has a vector that has no matching record
      vectorStore.getEmbeddedIds.mockImplementation((ns: string) => {
        if (ns === 'sessions') return ['s1', 's2', 's-orphan'];
        return [];
      });
      recordSource.getActiveRecordIds.mockImplementation((ns: string) => {
        if (ns === 'sessions') return ['s1', 's2'];
        return [];
      });

      const result = await manager.reconcile(BATCH_SIZE);

      expect(result.orphans_cleaned).toBe(1);
      expect(vectorStore.remove).toHaveBeenCalledWith('sessions', 's-orphan');
      expect(logger.warn).toHaveBeenCalledWith(
        'embedding',
        'Orphan vector cleaned',
        expect.objectContaining({ namespace: 'sessions', id: 's-orphan' }),
      );
    });

    it('returns zeros when no work is needed', async () => {
      recordSource.getEmbeddableRows.mockReturnValue([]);
      vectorStore.getEmbeddedIds.mockReturnValue([]);
      recordSource.getActiveRecordIds.mockReturnValue([]);

      const result = await manager.reconcile(BATCH_SIZE);

      expect(result.embedded).toBe(0);
      expect(result.orphans_cleaned).toBe(0);
      // No info log when no work done
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // cleanOrphans
  // -------------------------------------------------------------------------

  describe('cleanOrphans', () => {
    it('removes orphan vectors and returns count', () => {
      vectorStore.getEmbeddedIds.mockImplementation((ns: string) => {
        if (ns === 'spores') return ['sp1', 'sp2', 'sp-orphan1', 'sp-orphan2'];
        return [];
      });
      recordSource.getActiveRecordIds.mockImplementation((ns: string) => {
        if (ns === 'spores') return ['sp1', 'sp2'];
        return [];
      });

      const result = manager.cleanOrphans();

      expect(result.orphans_cleaned).toBe(2);
      expect(vectorStore.remove).toHaveBeenCalledWith('spores', 'sp-orphan1');
      expect(vectorStore.remove).toHaveBeenCalledWith('spores', 'sp-orphan2');
    });

    it('returns 0 when no orphans exist', () => {
      vectorStore.getEmbeddedIds.mockReturnValue(['a', 'b']);
      recordSource.getActiveRecordIds.mockReturnValue(['a', 'b']);

      const result = manager.cleanOrphans();

      expect(result.orphans_cleaned).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // rebuildAll
  // -------------------------------------------------------------------------

  describe('rebuildAll', () => {
    it('calls vectorStore.clear() and recordSource.clearAllEmbedded()', () => {
      vectorStore.clear.mockReturnValue({ cleared: 42 });

      const result = manager.rebuildAll();

      expect(vectorStore.clear).toHaveBeenCalled();
      expect(recordSource.clearAllEmbedded).toHaveBeenCalled();
      expect(result.queued).toBe(42);
      expect(logger.info).toHaveBeenCalledWith(
        'embedding',
        'Rebuild started',
        expect.objectContaining({ cleared: 42 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // reembedStale
  // -------------------------------------------------------------------------

  describe('reembedStale', () => {
    it('finds stale vectors and re-embeds them', async () => {
      vectorStore.getStaleIds.mockImplementation((ns: string) => {
        if (ns === 'sessions') return ['s-old1', 's-old2'];
        return [];
      });
      recordSource.getRecordContent.mockImplementation((ns: string, ids: string[]) => {
        if (ns === 'sessions') {
          return ids.map((id) => ({ id, text: `content for ${id}`, metadata: {} }));
        }
        return [];
      });

      const result = await manager.reembedStale(10);

      expect(result.reembedded).toBe(2);
      expect(provider.embed).toHaveBeenCalledTimes(2);
      expect(vectorStore.upsert).toHaveBeenCalledTimes(2);
    });

    it('returns 0 when no stale vectors exist', async () => {
      vectorStore.getStaleIds.mockReturnValue([]);

      const result = await manager.reembedStale(10);

      expect(result.reembedded).toBe(0);
      expect(provider.embed).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getDetails
  // -------------------------------------------------------------------------

  describe('getDetails', () => {
    it('combines vector stats with pending counts and provider info', () => {
      vectorStore.stats.mockReturnValue({
        total: 100,
        by_namespace: {
          sessions: { embedded: 50, stale: 2 },
          spores: { embedded: 50, stale: 0 },
        },
        models: { [MOCK_MODEL]: 100 },
      } satisfies VectorStoreStats);

      recordSource.getPendingCount.mockImplementation((ns: string) => {
        if (ns === 'sessions') return 1;
        if (ns === 'spores') return 2;
        return 0;
      });

      const details = manager.getDetails();

      expect(details.total).toBe(100);
      expect(details.pending.sessions).toBe(1);
      expect(details.pending.spores).toBe(2);
      expect(details.pending.plans).toBe(0);
      expect(details.pending.artifacts).toBe(0);
      expect(details.provider).toEqual({
        name: MOCK_PROVIDER_NAME,
        model: MOCK_MODEL,
        available: true,
      });
    });
  });

  // -------------------------------------------------------------------------
  // embedQuery
  // -------------------------------------------------------------------------

  describe('embedQuery', () => {
    it('passes through to provider.embed()', async () => {
      const result = await manager.embedQuery('search query text');

      expect(provider.embed).toHaveBeenCalledWith('search query text');
      expect(result).toEqual(MOCK_EMBEDDING);
    });

    it('returns null when provider returns null', async () => {
      provider.embed.mockResolvedValue(null);

      const result = await manager.embedQuery('query');

      expect(result).toBeNull();
    });
  });
});
