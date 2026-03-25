import { describe, it, expect, vi } from 'vitest';
import {
  handleEmbeddingDetails,
  handleEmbeddingRebuild,
  handleEmbeddingReconcile,
  handleEmbeddingCleanOrphans,
  handleEmbeddingReembedStale,
} from '@myco/daemon/api/embedding';
import { EMBEDDING_BATCH_SIZE } from '@myco/constants';
import type { EmbeddingManager } from '@myco/daemon/embedding/manager';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockManager(): {
  [K in keyof Pick<
    EmbeddingManager,
    'getDetails' | 'rebuildAll' | 'reconcile' | 'cleanOrphans' | 'reembedStale'
  >]: ReturnType<typeof vi.fn>;
} {
  return {
    getDetails: vi.fn().mockReturnValue({
      total: 42,
      by_namespace: { sessions: 20, spores: 22 },
      models: { 'bge-m3': 42 },
      pending: { sessions: 0, spores: 3 },
      provider: { name: 'ollama', model: 'bge-m3', dimensions: 1024 },
    }),
    rebuildAll: vi.fn().mockReturnValue({ queued: 42 }),
    reconcile: vi.fn().mockResolvedValue({
      embedded: 5,
      orphans_cleaned: 1,
      duration_ms: 123,
    }),
    cleanOrphans: vi.fn().mockReturnValue({ orphans_cleaned: 3 }),
    reembedStale: vi.fn().mockResolvedValue({ reembedded: 7 }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('embedding operations API', () => {
  it('handleEmbeddingDetails delegates to manager.getDetails()', () => {
    const manager = createMockManager();
    const result = handleEmbeddingDetails(manager as unknown as EmbeddingManager);

    expect(manager.getDetails).toHaveBeenCalledOnce();
    expect(result.body).toEqual({
      total: 42,
      by_namespace: { sessions: 20, spores: 22 },
      models: { 'bge-m3': 42 },
      pending: { sessions: 0, spores: 3 },
      provider: { name: 'ollama', model: 'bge-m3', dimensions: 1024 },
    });
  });

  it('handleEmbeddingRebuild delegates to manager.rebuildAll()', () => {
    const manager = createMockManager();
    const result = handleEmbeddingRebuild(manager as unknown as EmbeddingManager);

    expect(manager.rebuildAll).toHaveBeenCalledOnce();
    expect(result.body).toEqual({ queued: 42 });
  });

  it('handleEmbeddingReconcile delegates to manager.reconcile() with EMBEDDING_BATCH_SIZE', async () => {
    const manager = createMockManager();
    const result = await handleEmbeddingReconcile(manager as unknown as EmbeddingManager);

    expect(manager.reconcile).toHaveBeenCalledWith(EMBEDDING_BATCH_SIZE);
    expect(result.body).toEqual({
      embedded: 5,
      orphans_cleaned: 1,
      duration_ms: 123,
    });
  });

  it('handleEmbeddingCleanOrphans delegates to manager.cleanOrphans()', () => {
    const manager = createMockManager();
    const result = handleEmbeddingCleanOrphans(manager as unknown as EmbeddingManager);

    expect(manager.cleanOrphans).toHaveBeenCalledOnce();
    expect(result.body).toEqual({ orphans_cleaned: 3 });
  });

  it('handleEmbeddingReembedStale delegates to manager.reembedStale() with EMBEDDING_BATCH_SIZE', async () => {
    const manager = createMockManager();
    const result = await handleEmbeddingReembedStale(manager as unknown as EmbeddingManager);

    expect(manager.reembedStale).toHaveBeenCalledWith(EMBEDDING_BATCH_SIZE);
    expect(result.body).toEqual({ reembedded: 7 });
  });
});
