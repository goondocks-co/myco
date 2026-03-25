import { getEmbeddingQueueDepth } from '@myco/db/queries/embeddings.js';
import { loadConfig } from '../../config/loader.js';
import { EMBEDDING_BATCH_SIZE } from '../../constants.js';
import type { EmbeddingManager } from '../embedding/index.js';
import type { RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Status when no items are pending embedding. */
const EMBEDDING_STATUS_IDLE = 'idle';

/** Status when items are waiting to be embedded. */
const EMBEDDING_STATUS_PENDING = 'pending';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleGetEmbeddingStatus(vaultDir: string): Promise<RouteResponse> {
  const config = loadConfig(vaultDir);

  const { queue_depth, embedded_count } = getEmbeddingQueueDepth();

  return {
    body: {
      provider: config.embedding.provider,
      model: config.embedding.model,
      base_url: config.embedding.base_url ?? null,
      queue_depth,
      embedded_count,
      status: queue_depth === 0 ? EMBEDDING_STATUS_IDLE : EMBEDDING_STATUS_PENDING,
    },
  };
}

export function handleEmbeddingDetails(manager: EmbeddingManager): RouteResponse {
  const details = manager.getDetails();
  return { body: details };
}

export function handleEmbeddingRebuild(manager: EmbeddingManager): RouteResponse {
  const result = manager.rebuildAll();
  return { body: result };
}

export async function handleEmbeddingReconcile(manager: EmbeddingManager): Promise<RouteResponse> {
  const result = await manager.reconcile(EMBEDDING_BATCH_SIZE);
  return { body: result };
}

export function handleEmbeddingCleanOrphans(manager: EmbeddingManager): RouteResponse {
  const result = manager.cleanOrphans();
  return { body: result };
}

export async function handleEmbeddingReembedStale(manager: EmbeddingManager): Promise<RouteResponse> {
  const result = await manager.reembedStale(EMBEDDING_BATCH_SIZE);
  return { body: result };
}
