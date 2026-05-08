import { getEmbeddingQueueDepth } from '@myco/db/queries/embeddings.js';
import type { Database } from '@myco/db/client.js';
import { withDatabase } from '@myco/db/client.js';
import { loadMergedConfig } from '../../config/loader.js';
import { EMBEDDING_BATCH_SIZE } from '../../constants.js';
import type { EmbeddingManager } from '../embedding/index.js';
import type { RouteHandler, RouteRequest, RouteResponse } from '../router.js';
import {
  ALL_PROJECTS_SCOPE,
  type ProjectScope as DbProjectScope,
} from '@myco/grove/ids.js';
import {
  resolveGroveDbPath,
  resolveMycoHome,
} from '@myco/grove/paths.js';
import { loadGroveRecord } from '@myco/grove/registry.js';
import type { GroveRuntimeCache, EmbeddingRuntimeFactory } from '../grove-runtime-cache.js';
import type { Logger } from '../logger.js';
import { forEachGrove } from '../scope-iteration.js';
import { errorMessage } from '@myco/utils/error-message.js';
import {
  resolveActionScope,
  actionScopeKey,
  InvalidActionScopeError,
  type ActionScope,
} from './action-scope.js';
import { ActionInflightRegistry } from './action-inflight.js';

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

interface EmbeddingScopeOptions {
  db?: Database;
  scope?: DbProjectScope;
}

function readQueueDepthSafely(options: EmbeddingScopeOptions = {}): number {
  const scope = options.scope ?? ALL_PROJECTS_SCOPE;
  try {
    return options.db
      ? getEmbeddingQueueDepth(scope, options.db).queue_depth
      : getEmbeddingQueueDepth(scope).queue_depth;
  } catch {
    return 0;
  }
}

async function drainForegroundReconcile(manager: EmbeddingManager, options: EmbeddingScopeOptions = {}): Promise<{
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

    const queueDepth = readQueueDepthSafely(options);
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
    remaining_queue_depth: readQueueDepthSafely(options),
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
// Legacy handlers (status/details — read endpoints stay unchanged for now)
// ---------------------------------------------------------------------------

export async function handleGetEmbeddingStatus(
  vaultDir: string,
  options: EmbeddingScopeOptions = {},
): Promise<RouteResponse> {
  const config = loadMergedConfig(vaultDir);

  const scope = options.scope ?? ALL_PROJECTS_SCOPE;
  const { queue_depth, embedded_count } = options.db
    ? getEmbeddingQueueDepth(scope, options.db)
    : getEmbeddingQueueDepth(scope);

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

// Original single-Grove action handlers — kept exported because other
// code paths and existing tests import them by name. The new
// scope-aware route handlers below wrap these.

export async function handleEmbeddingRebuild(
  manager: EmbeddingManager,
  options: { async?: boolean } & EmbeddingScopeOptions = {},
): Promise<RouteResponse> {
  const result = manager.rebuildAll();
  if (options.async) {
    return {
      body: {
        ...result,
        queued_for_background: result.queued,
        batch_size: FOREGROUND_EMBEDDING_BATCH_SIZE,
      },
    };
  }
  const drained = await drainForegroundReconcile(manager, options);
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

// ---------------------------------------------------------------------------
// Scope-aware route handlers
// ---------------------------------------------------------------------------

export interface EmbeddingActionDeps {
  cache: GroveRuntimeCache;
  embeddingRuntimeFactory: EmbeddingRuntimeFactory;
  logger: Logger;
  /**
   * Resolve the embedding manager for the request's bound Grove. Used
   * for `kind: 'project'` so namespace-aware actions can run with the
   * existing per-request runtime instead of re-opening the DB.
   */
  resolveRequestRuntime: (req: RouteRequest) => { manager: EmbeddingManager; db?: Database };
  mycoHome?: string;
}

interface PerGroveResultBase {
  grove_id: string;
  grove_slug: string;
  ok: boolean;
  error?: string;
}

export function createEmbeddingActionHandlers(deps: EmbeddingActionDeps): {
  handleRebuild: RouteHandler;
  handleReconcile: RouteHandler;
  handleCleanOrphans: RouteHandler;
  handleReembedStale: RouteHandler;
} {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const inflight = new ActionInflightRegistry();

  function buildManagerForGrove(groveId: string): { manager: EmbeddingManager; db: Database; databasePath: string } {
    const databasePath = resolveGroveDbPath(groveId, mycoHome);
    const entry = deps.cache.getEmbeddingRuntime(databasePath, deps.embeddingRuntimeFactory);
    return { manager: entry.embeddingManager!, db: entry.db, databasePath };
  }

  async function dispatchSingleGrove<T>(
    groveId: string,
    run: (manager: EmbeddingManager, db: Database) => Promise<T> | T,
  ): Promise<PerGroveResultBase & T> {
    const grove = loadGroveRecord(groveId, mycoHome);
    const slug = grove?.slug ?? groveId;
    try {
      const { manager, db, databasePath } = buildManagerForGrove(groveId);
      const value = await deps.cache.withPinned(databasePath, async () =>
        withDatabase(db, async () => run(manager, db)),
      );
      return { grove_id: groveId, grove_slug: slug, ok: true, ...value } as PerGroveResultBase & T;
    } catch (err) {
      return {
        grove_id: groveId,
        grove_slug: slug,
        ok: false,
        error: errorMessage(err),
      } as PerGroveResultBase & T;
    }
  }

  async function dispatchAllGroves<T>(
    run: (manager: EmbeddingManager, db: Database) => Promise<T> | T,
  ): Promise<Array<PerGroveResultBase & T>> {
    const results: Array<PerGroveResultBase & T> = [];
    await forEachGrove(
      deps.cache,
      deps.logger,
      async (scope) => {
        try {
          const entry = deps.cache.getEmbeddingRuntime(scope.databasePath, deps.embeddingRuntimeFactory);
          const value = await run(entry.embeddingManager!, entry.db);
          results.push({
            grove_id: scope.grove.id,
            grove_slug: scope.grove.slug,
            ok: true,
            ...value,
          } as PerGroveResultBase & T);
        } catch (err) {
          results.push({
            grove_id: scope.grove.id,
            grove_slug: scope.grove.slug,
            ok: false,
            error: errorMessage(err),
          } as PerGroveResultBase & T);
        }
      },
      { mycoHome, jobName: 'embedding-action' },
    );
    return results;
  }

  async function dispatch<T>(
    endpoint: string,
    req: RouteRequest,
    run: (manager: EmbeddingManager, db: Database) => Promise<T> | T,
  ): Promise<RouteResponse> {
    let scope: ActionScope;
    try {
      scope = resolveActionScope({ body: req.body, requestContext: req.requestContext });
    } catch (err) {
      if (err instanceof InvalidActionScopeError) {
        return { status: 400, body: { error: 'invalid_scope', message: err.message } };
      }
      throw err;
    }

    const key = `${endpoint}:${actionScopeKey(scope)}`;
    return inflight.run(key, async (): Promise<RouteResponse> => {
      let results: Array<PerGroveResultBase & T>;
      if (scope.kind === 'all-groves') {
        results = await dispatchAllGroves(run);
      } else if (scope.kind === 'grove') {
        results = [await dispatchSingleGrove(scope.grove_id, run)];
      } else {
        // 'project' — embedding actions for spores/plans have project-
        // scoped namespaces, so for these endpoints 'project' is the
        // narrowed path. Today's EmbeddingManager fans out across the
        // Grove DB regardless of the request's project_id; the
        // narrowing happens via the scope-aware queue-depth filter
        // when the manager is invoked under withDatabase. Use the
        // request runtime so non-Grove (legacy) deployments still work.
        const runtime = deps.resolveRequestRuntime(req);
        const single: PerGroveResultBase & T = await (async () => {
          try {
            const value = await run(runtime.manager, runtime.db ?? (undefined as unknown as Database));
            return {
              grove_id: scope.grove_id,
              grove_slug:
                loadGroveRecord(scope.grove_id, mycoHome)?.slug ?? scope.grove_id,
              ok: true,
              ...value,
            } as PerGroveResultBase & T;
          } catch (err) {
            return {
              grove_id: scope.grove_id,
              grove_slug:
                loadGroveRecord(scope.grove_id, mycoHome)?.slug ?? scope.grove_id,
              ok: false,
              error: errorMessage(err),
            } as PerGroveResultBase & T;
          }
        })();
        results = [single];
      }
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      return { body: { scope, results, summary: { ok, failed } } };
    });
  }

  return {
    handleRebuild: async (req) =>
      dispatch('embedding/rebuild', req, async (manager, db) => {
        const queued = manager.rebuildAll().queued;
        const isAsync = req.query.async === 'true';
        if (isAsync) {
          return {
            queued,
            queued_for_background: queued,
            batch_size: FOREGROUND_EMBEDDING_BATCH_SIZE,
          };
        }
        const drained = await drainForegroundReconcile(manager, { db });
        return {
          queued,
          ...drained,
          batch_size: FOREGROUND_EMBEDDING_BATCH_SIZE,
        };
      }),
    handleReconcile: async (req) =>
      dispatch('embedding/reconcile', req, async (manager) => {
        const result = await manager.reconcile(FOREGROUND_EMBEDDING_BATCH_SIZE);
        return { ...result, batch_size: FOREGROUND_EMBEDDING_BATCH_SIZE };
      }),
    handleCleanOrphans: async (req) =>
      dispatch('embedding/clean-orphans', req, (manager) => manager.cleanOrphans()),
    handleReembedStale: async (req) =>
      dispatch('embedding/reembed-stale', req, async (manager) => {
        const result = await drainForegroundReembedStale(manager);
        return { ...result, batch_size: FOREGROUND_EMBEDDING_BATCH_SIZE };
      }),
  };
}

// Suppress unused-warning fallback for EMBEDDING_BATCH_SIZE re-export legacy.
void EMBEDDING_BATCH_SIZE;
