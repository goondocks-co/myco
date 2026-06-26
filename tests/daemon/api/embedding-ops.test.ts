import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { vi } from '../../helpers/vi-shim.js';
import {
  handleEmbeddingDetails,
  createEmbeddingDetailsHandler,
  handleEmbeddingRebuild,
  handleEmbeddingReconcile,
  handleEmbeddingCleanOrphans,
  handleEmbeddingReembedStale,
} from '@myco/daemon/api/embedding';
import type { EmbeddingManager } from '@myco/daemon/embedding/manager';
import { CANOPY_ENTRIES_TABLE } from '@myco/db/schema-ddl';
import type { RouteRequest } from '@myco/daemon/router';
import { createCanopyDescribeBacklogReader } from '@myco/canopy/describe-backlog';

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
      by_namespace: {
        sessions: { embedded: 20, stale: 0 },
        spores: { embedded: 22, stale: 0 },
      },
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
    const result = handleEmbeddingDetails(manager as unknown as EmbeddingManager, {
      projectId: 'proj_test',
      canopyDescribe: { pending: 1, undescribed: 0, stale: 1 },
    });

    expect(manager.getDetails).toHaveBeenCalledOnce();
    expect(result.body).toEqual({
      total: 42,
      by_namespace: {
        sessions: { embedded: 20, stale: 0 },
        spores: { embedded: 22, stale: 0 },
      },
      models: { 'bge-m3': 42 },
      pending: { sessions: 0, spores: 3 },
      provider: { name: 'ollama', model: 'bge-m3', dimensions: 1024 },
      canopy_describe: { pending: 1, undescribed: 0, stale: 1 },
      namespace_breakdown: {
        sessions: { embedded: 20, pending: 0, stale: 0, total: 20 },
        spores: { embedded: 22, pending: 3, stale: 0, total: 25 },
        canopy_entries: { embedded: 0, pending: 0, stale: 1, total: 0 },
      },
    });
  });

  it('createEmbeddingDetailsHandler reads Canopy backlog under the request runtime scope', async () => {
    const manager = createMockManager();
    const db = new Database(':memory:');
    db.prepare(CANOPY_ENTRIES_TABLE).run();
    db.prepare(
      `INSERT INTO canopy_entries (
        project_id,
        path,
        content_hash,
        size_bytes,
        token_estimate,
        line_count,
        mechanical_updated_at,
        llm_description,
        llm_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('proj_test', 'stale.ts', 'hash-1', 10, 5, 1, 200, 'old description', 100);
    db.prepare(
      `INSERT INTO canopy_entries (
        project_id,
        path,
        content_hash,
        size_bytes,
        token_estimate,
        line_count,
        mechanical_updated_at,
        llm_description,
        llm_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('proj_other', 'other.ts', 'hash-2', 10, 5, 1, 200, null, null);

    const handler = createEmbeddingDetailsHandler({
      resolveRequestRuntime: () => ({
        manager: manager as unknown as EmbeddingManager,
        db,
      }),
      canopyDescribeBacklog: createCanopyDescribeBacklogReader(),
    });

    const result = await handler({
      query: {},
      requestContext: {
        projectId: 'proj_test',
        groveId: 'grove_test',
        machineId: 'machine_test',
        projectVaultDir: '/tmp/project/.myco',
        projectRoot: '/tmp/project',
        databasePath: '/tmp/grove/myco.db',
        sessionId: null,
        tenancySource: 'caller',
      },
    } as unknown as RouteRequest);

    expect(result.body).toEqual(expect.objectContaining({
      canopy_describe: { pending: 1, undescribed: 0, stale: 1, stuck: 0 },
      namespace_breakdown: expect.objectContaining({
        canopy_entries: { embedded: 0, pending: 0, stale: 1, total: 0 },
      }),
    }));
    db.close();
  });

  it('handleEmbeddingRebuild delegates to manager.rebuildAll()', async () => {
    const manager = createMockManager();
    manager.reconcile.mockResolvedValue({ embedded: 0, stale_reembedded: 0, orphans_cleaned: 0, duration_ms: 123 });
    const result = await handleEmbeddingRebuild(manager as unknown as EmbeddingManager);

    expect(manager.rebuildAll).toHaveBeenCalledOnce();
    expect(manager.reconcile).toHaveBeenCalledWith(50);
    expect(result.body).toEqual(expect.objectContaining({ queued: 42, batch_size: 50 }));
  });

  it('handleEmbeddingReconcile delegates to manager.reconcile() with foreground batch size', async () => {
    const manager = createMockManager();
    const result = await handleEmbeddingReconcile(manager as unknown as EmbeddingManager);

    expect(manager.reconcile).toHaveBeenCalledWith(50);
    expect(result.body).toEqual({
      embedded: 5,
      orphans_cleaned: 1,
      duration_ms: 123,
      batch_size: 50,
    });
  });

  it('handleEmbeddingCleanOrphans delegates to manager.cleanOrphans()', () => {
    const manager = createMockManager();
    const result = handleEmbeddingCleanOrphans(manager as unknown as EmbeddingManager);

    expect(manager.cleanOrphans).toHaveBeenCalledOnce();
    expect(result.body).toEqual({ orphans_cleaned: 3 });
  });

  it('handleEmbeddingReembedStale drains stale vectors with foreground batch size', async () => {
    const manager = createMockManager();
    manager.reembedStale
      .mockResolvedValueOnce({ reembedded: 7 })
      .mockResolvedValueOnce({ reembedded: 0 });
    const result = await handleEmbeddingReembedStale(manager as unknown as EmbeddingManager);

    expect(manager.reembedStale).toHaveBeenCalledWith(50);
    expect(result.body).toEqual({ reembedded: 7, passes: 1, batch_size: 50 });
  });
});
