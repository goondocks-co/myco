import { getEmbeddingQueueDepth } from '@myco/db/queries/embeddings.js';
import { loadMergedConfig } from '../../config/loader.js';
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
const FOREGROUND_EMBEDDING_BATCH_SIZE = 50;
const FOREGROUND_RECONCILE_MAX_PASSES = 25;
const FOREGROUND_REEMBED_MAX_PASSES = 25;

function readQueueDepthSafely(): number {
  try {
    return getEmbeddingQueueDepth().queue_depth;
  } catch {
    return 0;
  }
}

async function drainForegroundReconcile(manager: EmbeddingManager): Promise<{
  embedded: number;
  stale_reembedded: number;
  orphans_cleaned: number;
  duration_ms: number;
  passes: number;
  remaining_queue_depth: number;
}> {
  const startedAt = Date.now();
  let embedded = 0;
  let stale_reembedded = 0;
  let orphans_cleaned = 0;
  let passes = 0;

  for (; passes < FOREGROUND_RECONCILE_MAX_PASSES; passes++) {
    const result = await manager.reconcile(FOREGROUND_EMBEDDING_BATCH_SIZE);
    embedded += result.embedded;
    stale_reembedded += result.stale_reembedded;
    orphans_cleaned += result.orphans_cleaned;

    const queueDepth = readQueueDepthSafely();
    if (queueDepth === 0) {
      return {
        embedded,
        stale_reembedded,
        orphans_cleaned,
        duration_ms: Date.now() - startedAt,
        passes: passes + 1,
        remaining_queue_depth: 0,
      };
    }

    if (result.embedded === 0 && result.stale_reembedded === 0 && result.orphans_cleaned === 0) {
      return {
        embedded,
        stale_reembedded,
        orphans_cleaned,
        duration_ms: Date.now() - startedAt,
        passes: passes + 1,
        remaining_queue_depth: queueDepth,
      };
    }
  }

  return {
    embedded,
    stale_reembedded,
    orphans_cleaned,
    duration_ms: Date.now() - startedAt,
    passes,
    remaining_queue_depth: readQueueDepthSafely(),
  };
}

async function drainForegroundReembedStale(manager: EmbeddingManager): Promise<{
  reembedded: number;
  passes: number;
}> {
  let reembedded = 0;
  let passes = 0;

  for (; passes < FOREGROUND_REEMBED_MAX_PASSES; passes++) {
    const result = await manager.reembedStale(FOREGROUND_EMBEDDING_BATCH_SIZE);
    reembedded += result.reembedded;
    if (result.reembedded === 0) break;
  }

  return { reembedded, passes };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleGetEmbeddingStatus(vaultDir: string): Promise<RouteResponse> {
  const config = loadMergedConfig(vaultDir);

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

export async function handleEmbeddingRebuild(
  manager: EmbeddingManager,
  options: { async?: boolean } = {},
): Promise<RouteResponse> {
  const result = manager.rebuildAll();
  // Fire-and-forget path: return once records are marked pending, without
  // waiting for the foreground drain. Used by `myco update`'s one-time
  // metadata migration so the CLI doesn't hang on a large re-embed that
  // the background reconcile job is already queued to handle.
  if (options.async) {
    return {
      body: {
        ...result,
        queued_for_background: result.queued,
        batch_size: FOREGROUND_EMBEDDING_BATCH_SIZE,
      },
    };
  }
  const drained = await drainForegroundReconcile(manager);
  return {
    body: {
      ...result,
      ...drained,
      batch_size: FOREGROUND_EMBEDDING_BATCH_SIZE,
    },
  };
}

export async function handleEmbeddingReconcile(manager: EmbeddingManager): Promise<RouteResponse> {
  const result = await manager.reconcile(FOREGROUND_EMBEDDING_BATCH_SIZE);
  return { body: { ...result, batch_size: FOREGROUND_EMBEDDING_BATCH_SIZE } };
}

export function handleEmbeddingCleanOrphans(manager: EmbeddingManager): RouteResponse {
  const result = manager.cleanOrphans();
  return { body: result };
}

export async function handleEmbeddingReembedStale(manager: EmbeddingManager): Promise<RouteResponse> {
  const result = await drainForegroundReembedStale(manager);
  return { body: { ...result, batch_size: FOREGROUND_EMBEDDING_BATCH_SIZE } };
}
