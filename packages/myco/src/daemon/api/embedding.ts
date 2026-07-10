import fs from 'node:fs';
import { getEmbeddingQueueDepth } from '@myco/db/queries/embeddings.js';
import type { Database } from '@myco/db/client.js';
import { withDatabase } from '@myco/db/client.js';
import { loadMergedConfig } from '../../config/loader.js';
import { resolveProjectRoot } from '../../vault/resolve.js';
import { EMBEDDING_BATCH_SIZE } from '../../constants.js';
import type { EmbeddingManager } from '../embedding/index.js';
import type { RouteHandler, RouteRequest, RouteResponse } from '../router.js';
import {
  ALL_PROJECTS_SCOPE,
  type ProjectScope as DbProjectScope,
} from '@myco/grove/ids.js';
import { projectScopeFromRequestContext } from '@myco/grove/request-context.js';
import {
  resolveGroveDbPath,
  resolveMycoHome,
} from '@myco/grove/paths.js';
import { assertOwnedGrove, loadGroveRecord } from '@myco/grove/registry.js';
import type { GroveRuntimeCache, EmbeddingRuntimeFactory } from '../grove-runtime-cache.js';
import type { Logger } from '../logger.js';
import { forEachGrove } from '../scope-iteration.js';
import { ActionInflightRegistry } from './action-inflight.js';
import {
  runScopedAction,
  wrapPerGroveResult,
  type PerGroveResultBase as SharedPerGroveResultBase,
} from './scoped-dispatch.js';
import type { CanopyDescribeBacklogReader } from '@myco/canopy/describe-backlog.js';
import type { CanopyDescribeBacklog } from '@myco/db/queries/canopy.js';

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
  groveId?: string | null;
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
  // A Team Host serving this project for a member has no local working
  // tree — degrade to machine+grove tiers (empty project tier) instead of
  // throwing "myco.yaml not found" (same signal + mechanism as `okf.ts`).
  const treeAvailable = fs.existsSync(resolveProjectRoot(vaultDir));
  const config = loadMergedConfig(vaultDir, {
    groveId: options.groveId ?? null,
    projectTierOptional: !treeAvailable,
  });

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

export interface EmbeddingStatusDeps {
  resolveRequestRuntime: (req: RouteRequest) => { manager: EmbeddingManager; db: Database };
}

export interface EmbeddingNamespaceBreakdown {
  embedded: number;
  pending: number;
  stale: number;
  total: number;
}

export function createEmbeddingStatusHandler(deps: EmbeddingStatusDeps): RouteHandler {
  return async (req) => {
    const ctx = req.requestContext;
    if (!ctx) {
      throw new Error('Embedding status requires a caller-supplied Grove request context');
    }
    const runtime = deps.resolveRequestRuntime(req);
    const scope = projectScopeFromRequestContext(ctx);
    return withDatabase(runtime.db, () =>
      handleGetEmbeddingStatus(ctx.projectVaultDir, {
        scope,
        groveId: ctx.groveId ?? null,
      }),
    );
  };
}

export function handleEmbeddingDetails(
  manager: EmbeddingManager,
  options: {
    projectId?: string | null;
    canopyDescribe: CanopyDescribeBacklog;
  },
): RouteResponse {
  const details = manager.getDetails({ projectId: options.projectId });
  return {
    body: {
      ...details,
      canopy_describe: options.canopyDescribe,
      namespace_breakdown: buildNamespaceBreakdown(details, options.canopyDescribe),
    },
  };
}

function buildNamespaceBreakdown(
  details: ReturnType<EmbeddingManager['getDetails']>,
  canopyDescribe: CanopyDescribeBacklog,
): Record<string, EmbeddingNamespaceBreakdown> {
  const namespaces = new Set([
    ...Object.keys(details.by_namespace),
    ...Object.keys(details.pending),
    'canopy_entries',
  ]);
  const breakdown: Record<string, EmbeddingNamespaceBreakdown> = {};
  for (const namespace of namespaces) {
    const stats = details.by_namespace[namespace];
    const embedded = stats?.embedded ?? 0;
    let pending = details.pending[namespace] ?? 0;
    let stale = stats?.stale ?? 0;
    if (namespace === 'canopy_entries') {
      pending += canopyDescribe.undescribed;
      stale = Math.max(stale, canopyDescribe.stale);
    }
    breakdown[namespace] = {
      embedded,
      pending,
      stale,
      total: embedded + pending,
    };
  }
  return breakdown;
}

export interface EmbeddingDetailsDeps {
  resolveRequestRuntime: (req: RouteRequest) => { manager: EmbeddingManager; db: Database };
  canopyDescribeBacklog: CanopyDescribeBacklogReader;
}

export function createEmbeddingDetailsHandler(deps: EmbeddingDetailsDeps): RouteHandler {
  return async (req) => {
    const ctx = req.requestContext;
    if (!ctx) {
      throw new Error('Embedding details requires a caller-supplied Grove request context');
    }
    const runtime = deps.resolveRequestRuntime(req);
    const scopeParam = typeof req.query.scope === 'string' ? req.query.scope : 'project';
    const scope = scopeParam === 'grove'
      ? ALL_PROJECTS_SCOPE
      : projectScopeFromRequestContext(ctx);
    const projectId = scope.kind === 'project' ? scope.id : null;

    return withDatabase(runtime.db, () =>
      handleEmbeddingDetails(runtime.manager, {
        projectId,
        canopyDescribe: deps.canopyDescribeBacklog.read(scope, { groveId: ctx.groveId ?? null }),
      }),
    );
  };
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
  resolveRequestRuntime: (req: RouteRequest) => { manager: EmbeddingManager; db: Database };
  /** The current daemon's service dir; passed through to `forEachGrove` to enforce the served-by boundary. */
  daemonStateDir: string;
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

  async function dispatchSingleGrove<T extends object>(
    groveId: string,
    run: (manager: EmbeddingManager, db: Database) => Promise<T> | T,
  ): Promise<PerGroveResultBase & T> {
    // Body-scope grove ids arrive outside the request-context funnel, so
    // existence and home-ownership gate here — BEFORE
    // wrapPerGroveResult (which would swallow the refusal into a result
    // row) and before the cache opens the Grove DB and builds an
    // embedding runtime on it. Throws propagate to the transport
    // (403 foreign_grove / 404 grove_not_found).
    const grove = assertOwnedGrove(groveId, mycoHome);
    return wrapPerGroveResult(groveId, grove.slug, async () => {
      const { manager, db, databasePath } = buildManagerForGrove(groveId);
      return deps.cache.withPinned(databasePath, async () =>
        withDatabase(db, async () => run(manager, db)),
      );
    });
  }

  async function dispatchAllGroves<T extends object>(
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
      { mycoHome, daemonStateDir: deps.daemonStateDir, jobName: 'embedding-action', parallel: true },
    );
    return results;
  }

  async function dispatch<T extends object>(
    endpoint: string,
    req: RouteRequest,
    run: (manager: EmbeddingManager, db: Database) => Promise<T> | T,
  ): Promise<RouteResponse> {
    return runScopedAction<T>(endpoint, req, inflight, async (scope) => {
      if (scope.kind === 'all-groves') return dispatchAllGroves(run);
      if (scope.kind === 'grove') return [await dispatchSingleGrove(scope.grove_id, run)];
      // 'project' — embedding actions for spores/plans have project-
      // scoped namespaces, so 'project' is the narrowed path. The
      // request runtime is already Grove-bound by the action scope.
      const runtime = deps.resolveRequestRuntime(req);
      const slug = loadGroveRecord(scope.grove_id, mycoHome)?.slug ?? scope.grove_id;
      return [await wrapPerGroveResult(scope.grove_id, slug, () =>
        run(runtime.manager, runtime.db),
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
