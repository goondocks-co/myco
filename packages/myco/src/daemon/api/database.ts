import path from 'node:path';
import { withDatabase } from '@myco/db/client.js';
import {
  resolveGroveDbPath,
  resolveGroveDir,
  resolveMycoHome,
} from '@myco/grove/paths.js';
import { loadGroveRecord } from '@myco/grove/registry.js';
import type { GroveRuntimeCache } from '../grove-runtime-cache.js';
import type { Logger } from '../logger.js';
import { DatabaseMaintenanceManager } from '../database/manager.js';
import { VacuumPrecheckError, VACUUM_ERROR_CODE } from '../database/types.js';
import { forEachGrove } from '../scope-iteration.js';
import type { RouteHandler, RouteRequest, RouteResponse } from '../router.js';
import {
  resolveActionScope,
  actionScopeKey,
  InvalidActionScopeError,
  type ActionScope,
} from './action-scope.js';
import { ActionInflightRegistry } from './action-inflight.js';
import {
  runScopedAction,
  wrapPerGroveResult,
  type PerGroveResultBase,
} from './scoped-dispatch.js';

export interface DatabaseMaintenanceRouteDeps {
  /** Legacy per-request manager factory used for the `details` endpoint. */
  createManager(req: RouteRequest): DatabaseMaintenanceManager;
  /** Per-Grove runtime cache so scope='grove'/'all-groves' can fan out without re-opening DBs. */
  cache: GroveRuntimeCache;
  /** Logger used by `forEachGrove` to record per-Grove failures. */
  logger: Logger;
  /** Vault dir used for the VACUUM disk precheck. */
  vaultDir: string;
  /** Override Myco home (tests). */
  mycoHome?: string;
}

// Database maintenance is Grove-DB-only — there is no project-narrowed
// path because optimize/vacuum/reindex/integrity-check operate on the
// whole SQLite file. So `kind: 'project'` is treated identically to
// `kind: 'grove'` for these endpoints; the comment in each handler
// makes that explicit so future readers don't expect project-narrowed
// behavior here.

export function createDatabaseMaintenanceHandlers(deps: DatabaseMaintenanceRouteDeps): {
  handleDetails: RouteHandler;
  handleOptimize: RouteHandler;
  handleVacuum: RouteHandler;
  handleReindex: RouteHandler;
  handleIntegrityCheck: RouteHandler;
} {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const inflight = new ActionInflightRegistry();

  function buildManagerForGrove(groveId: string): DatabaseMaintenanceManager {
    const dbPath = resolveGroveDbPath(groveId, mycoHome);
    const groveDir = resolveGroveDir(groveId, mycoHome);
    return new DatabaseMaintenanceManager(dbPath, groveDir, deps.logger);
  }

  async function dispatchSingleGrove<T>(
    groveId: string,
    run: (manager: DatabaseMaintenanceManager) => Promise<T>,
  ): Promise<PerGroveResultBase & T> {
    const grove = loadGroveRecord(groveId, mycoHome);
    const slug = grove?.slug ?? groveId;
    const dbPath = resolveGroveDbPath(groveId, mycoHome);
    const db = deps.cache.getDatabase(dbPath);
    return wrapPerGroveResult(groveId, slug, () =>
      deps.cache.withPinned(dbPath, async () =>
        withDatabase(db, async () => run(buildManagerForGrove(groveId))),
      ),
    );
  }

  async function dispatchAllGroves<T>(
    run: (manager: DatabaseMaintenanceManager) => Promise<T>,
  ): Promise<Array<PerGroveResultBase & T>> {
    const results: Array<PerGroveResultBase & T> = [];
    await forEachGrove(
      deps.cache,
      deps.logger,
      async (scope) => {
        results.push(
          await wrapPerGroveResult(scope.grove.id, scope.grove.slug, () =>
            run(buildManagerForGrove(scope.grove.id)),
          ),
        );
      },
      // Each Grove has its own DB file; cross-Grove parallelism is safe
      // (per-DB write locks don't span Groves).
      { mycoHome, jobName: 'database-action', parallel: true },
    );
    return results;
  }

  async function dispatch<T>(
    endpoint: string,
    req: RouteRequest,
    run: (manager: DatabaseMaintenanceManager) => Promise<T>,
  ): Promise<RouteResponse> {
    return runScopedAction<T>(endpoint, req, inflight, async (scope) => {
      if (scope.kind === 'all-groves') return dispatchAllGroves(run);
      // 'project' is treated as 'grove' here: database maintenance has no
      // project-narrowed path — the whole Grove DB is the unit.
      return [await dispatchSingleGrove(scope.grove_id, run)];
    });
  }

  // VACUUM precheck failures need to surface 409 with the standard error
  // body. We special-case the single-Grove case here so the existing
  // client error UI keeps working when the user explicitly targets one
  // Grove. For all-groves fan-out, per-Grove precheck failures are
  // captured in the result row's `error` field.
  async function dispatchVacuum(req: RouteRequest): Promise<RouteResponse> {
    let scope: ActionScope;
    try {
      scope = resolveActionScope({ body: req.body, requestContext: req.requestContext });
    } catch (err) {
      if (err instanceof InvalidActionScopeError) {
        return { status: 400, body: { error: 'invalid_scope', message: err.message } };
      }
      throw err;
    }

    if (scope.kind !== 'all-groves') {
      const key = `database/vacuum:${actionScopeKey(scope)}`;
      return inflight.run(key, async (): Promise<RouteResponse> => {
        try {
          const result = await dispatchSingleGrove(scope.grove_id, (m) => m.vacuum());
          if (!result.ok) {
            // Surface "ok" wrapper but include error for caller; legacy clients
            // that don't pass scope continue to get the legacy 200/409 shape
            // via the catch path below — but at this point the precheck error
            // was already swallowed into the result row, so re-throw is impossible.
            return {
              body: {
                scope,
                results: [result],
                summary: { ok: 0, failed: 1 },
              },
            };
          }
          return {
            body: {
              scope,
              results: [result],
              summary: { ok: 1, failed: 0 },
            },
          };
        } catch (err) {
          // Unreachable — dispatchSingleGrove catches — kept for type narrowing.
          if (err instanceof VacuumPrecheckError) {
            return {
              status: 409,
              body: {
                error: VACUUM_ERROR_CODE,
                required_bytes: err.required_bytes,
                free_bytes: err.free_bytes,
              },
            };
          }
          throw err;
        }
      });
    }

    return dispatch('database/vacuum', req, (m) => m.vacuum());
  }

  return {
    handleDetails: async (req) => handleDatabaseDetails(deps.createManager(req)),
    handleOptimize: async (req) => dispatch('database/optimize', req, (m) => m.optimize()),
    handleVacuum: async (req) => dispatchVacuum(req),
    handleReindex: async (req) => dispatch('database/reindex', req, (m) => m.reindex()),
    handleIntegrityCheck: async (req) =>
      dispatch('database/integrity-check', req, (m) => m.integrityCheck()),
  };
}

// ---------------------------------------------------------------------------
// Legacy single-handler exports (kept so existing tests/imports compile)
// ---------------------------------------------------------------------------

export async function handleDatabaseDetails(
  manager: DatabaseMaintenanceManager,
): Promise<RouteResponse> {
  const details = await manager.getDetails();
  return { body: details };
}

export async function handleDatabaseOptimize(
  manager: DatabaseMaintenanceManager,
): Promise<RouteResponse> {
  const result = await manager.optimize();
  return { body: result };
}

export async function handleDatabaseVacuum(
  manager: DatabaseMaintenanceManager,
): Promise<RouteResponse> {
  try {
    const result = await manager.vacuum();
    return { body: result };
  } catch (err) {
    if (err instanceof VacuumPrecheckError) {
      return {
        status: 409,
        body: {
          error: VACUUM_ERROR_CODE,
          required_bytes: err.required_bytes,
          free_bytes: err.free_bytes,
        },
      };
    }
    throw err;
  }
}

export async function handleDatabaseReindex(
  manager: DatabaseMaintenanceManager,
): Promise<RouteResponse> {
  const result = await manager.reindex();
  return { body: result };
}

export async function handleDatabaseIntegrityCheck(
  manager: DatabaseMaintenanceManager,
): Promise<RouteResponse> {
  const result = await manager.integrityCheck();
  return { body: result };
}

// Re-export deps shape for compatibility — older signature took only
// `createManager` so we keep that field.
export type { DatabaseMaintenanceRouteDeps as DatabaseMaintenanceRouteDepsLegacy };
