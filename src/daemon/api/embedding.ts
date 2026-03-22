import { getEmbeddingQueueDepth } from '@myco/db/queries/embeddings.js';
import { loadConfig } from '../../config/loader.js';
import type { RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Status when no items are pending embedding. */
const EMBEDDING_STATUS_IDLE = 'idle';

/** Status when items are waiting to be embedded. */
const EMBEDDING_STATUS_PENDING = 'pending';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGetEmbeddingStatus(vaultDir: string): Promise<RouteResponse> {
  const config = loadConfig(vaultDir);

  const { queue_depth, embedded_count } = await getEmbeddingQueueDepth();

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
