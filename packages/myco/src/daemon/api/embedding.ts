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
import { ActionInflightRegistry } from './action-inflight.js';
import {
  runScopedAction,
  wrapPerGroveResult,
  type PerGroveResultBase as SharedPerGroveResultBase,
} from './scoped-dispatch.js';

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

export function handleEmbeddingDetails(
  manager: EmbeddingManager,
  options: { projectId?: string | null } = {},
): RouteResponse {
  const details = manager.getDetails({ projectId: options.projectId });
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

type PerGroveResultBase = SharedPerGroveResultBase;

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
    return wrapPerGroveResult(groveId, slug, async () => {
      const { manager, db, databasePath } = buildManagerForGrove(groveId);
      return deps.cache.withPinned(databasePath, async () =>
        withDatabase(db, async () => run(manager, db)),
      );
    });
  }

  async function dispatchAllGroves<T>(
    run: (manager: EmbeddingManager, db: Database) => Promise<T> | T,
  ): Promise<Array<PerGroveResultBase & T>> {
    const results: Array<PerGroveResultBase & T> = [];
    await forEachGrove(
      deps.cache,
      deps.logger,
      async (scope) => {
        results.push(
          await wrapPerGroveResult(scope.grove.id, scope.grove.slug, () => {
            const entry = deps.cache.getEmbeddingRuntime(scope.databasePath, deps.embeddingRuntimeFactory);
            return run(entry.embeddingManager!, entry.db);
          }),
        );
      },
      // Each Grove has its own vectors.db + DB file; cross-Grove
      // parallelism is safe.
      { mycoHome, jobName: 'embedding-action', parallel: true },
    );
    return results;
  }

  async function dispatch<T>(
    endpoint: string,
    req: RouteRequest,
    run: (manager: EmbeddingManager, db: Database) => Promise<T> | T,
  ): Promise<RouteResponse> {
    return runScopedAction<T>(endpoint, req, inflight, async (scope) => {
      if (scope.kind === 'all-groves') return dispatchAllGroves(run);
      if (scope.kind === 'grove') return [await dispatchSingleGrove(scope.grove_id, run)];
      // 'project' — embedding actions for spores/plans have project-
      // scoped namespaces, so 'project' is the narrowed path. Today's
      // EmbeddingManager fans out across the Grove DB regardless of the
      // request's project_id; the narrowing happens via the scope-aware
      // queue-depth filter when the manager is invoked under
      // withDatabase. Use the request runtime so non-Grove (legacy)
      // deployments still work.
      const runtime = deps.resolveRequestRuntime(req);
      const slug = loadGroveRecord(scope.grove_id, mycoHome)?.slug ?? scope.grove_id;
      // The legacy resolver may surface a runtime without a DB handle
      // when the request lacks Grove context. Surface that explicitly
      // as a per-Grove failure rather than passing `undefined as
      // Database` and trusting the manager not to reach for it.
      if (!runtime.db) {
        return [{
          grove_id: scope.grove_id,
          grove_slug: slug,
          ok: false,
          error: 'embedding action requires a Grove-scoped database; request context is missing one',
        } as PerGroveResultBase & T];
      }
      const runtimeDb: Database = runtime.db;
      return [await wrapPerGroveResult(scope.grove_id, slug, () =>
        run(runtime.manager, runtimeDb),
      )];
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
