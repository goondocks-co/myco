/**
 * Route registration for the four `/api/config*` endpoints.
 *
 * Extracted from `main.ts` so route-wiring is independently testable:
 * tests can register these against any object that implements
 * `registerRoute(method, path, handler)` and assert that the per-request
 * `requestContext.projectVaultDir` is threaded through. Previously the
 * routes were inlined in `main.ts` and the only assertion available was
 * at the handler level — which couldn't catch a wiring regression that
 * fed `bootstrapVaultDir` into a Grove-aware handler.
 */

import {
  handleGetConfig,
  handleGetMergedConfig,
  handleGetLocalConfig,
  handlePutScopedConfig,
} from './config.js';
import type { RouteRequest } from '../router.js';

export interface ConfigRouteServer {
  registerRoute(
    method: string,
    routePath: string,
    handler: (req: RouteRequest) => Promise<unknown>,
  ): void;
}

export interface ConfigRouteDeps {
  /** Fallback vault dir when a request arrives without a `requestContext`. */
  bootstrapVaultDir: string;
  /** Fallback Grove id when a request arrives without one. */
  bootGroveId: string | null;
  /**
   * Optional side-effect hook fired after a successful PUT /api/config/scoped.
   * Receives the resolved per-request scope (vaultDir + groveId) so reactions,
   * notifications, and cache invalidations can target the project that was
   * actually written.
   */
  onScopedWrite?: (params: {
    request: RouteRequest;
    body: { scope: 'project' | 'local'; patch?: unknown; clear?: string[] };
    vaultDir: string;
    groveId: string | null;
  }) => Promise<void> | void;
}

export function registerConfigRoutes(
  server: ConfigRouteServer,
  deps: ConfigRouteDeps,
): void {
  const vaultDirFor = (req: RouteRequest): string =>
    req.requestContext?.projectVaultDir ?? deps.bootstrapVaultDir;
  const groveIdFor = (req: RouteRequest): string | null =>
    req.requestContext?.groveId ?? deps.bootGroveId;

  server.registerRoute('GET', '/api/config', async (req) =>
    handleGetConfig(vaultDirFor(req)));

  server.registerRoute('GET', '/api/config/merged', async (req) =>
    handleGetMergedConfig(vaultDirFor(req), { groveId: groveIdFor(req) }));

  server.registerRoute('GET', '/api/config/local', async (req) =>
    handleGetLocalConfig(vaultDirFor(req)));

  server.registerRoute('PUT', '/api/config/scoped', async (req) => {
    const vaultDir = vaultDirFor(req);
    const result = await handlePutScopedConfig(vaultDir, req.body);
    const status = (result as { status?: number }).status;
    if ((!status || status < 400) && deps.onScopedWrite) {
      const body = req.body as {
        scope: 'project' | 'local';
        patch?: unknown;
        clear?: string[];
      };
      await deps.onScopedWrite({
        request: req,
        body,
        vaultDir,
        groveId: groveIdFor(req),
      });
    }
    return result;
  });
}
