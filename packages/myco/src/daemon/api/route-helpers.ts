/**
 * The HTTP route wrapper every tenant-scoped route runs through.
 *
 * Why this exists: the global daemon synthesizes a fallback (bootstrap-anchor)
 * request context for EVERY request before handlers run (server.ts:347), so a
 * handler can never trust "is requestContext present?" as authorization.
 * `tenantRoute` resolves the principal and authorizes BEFORE the handler sees
 * the request, so the handler only ever runs with caller-supplied tenancy that
 * survived the context-switch auth gate.
 *
 * On ANY tenancy violation it fails closed AND loud: reject with 400 and emit a
 * visible `tenancy.violation` warning. It never swallows the violation and never
 * lets the handler fall through to the daemon's own anchor vault — that is the
 * cross-tenant leak this seam exists to make impossible.
 */

import {
  resolvePrincipal,
  authorize,
  TenancyViolationError,
  type RequestPrincipal,
} from '../request-principal.js';
import { LOG_KINDS } from '../../constants/log-kinds.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { DaemonLogger } from '../logger.js';

/**
 * Wrap a tenant-scoped route handler so it ALWAYS runs with an authorized
 * principal. On any tenancy violation: reject 400 + emit `tenancy.violation`
 * (fail closed + loud). The handler never sees a synthesized/anchor context.
 */
export function tenantRoute(
  deps: { machineId: string; logger: DaemonLogger },
  handler: (req: RouteRequest, principal: RequestPrincipal) => Promise<RouteResponse>,
): (req: RouteRequest) => Promise<RouteResponse> {
  return async (req) => {
    let principal: RequestPrincipal;
    try {
      // `MycoRequestContext` types project/grove ids as `string | null`,
      // while `resolvePrincipal` accepts `string | undefined`. Coalesce the
      // nulls to undefined at this boundary — a null id is "absent tenancy"
      // and the resolver already rejects it (a legacy non-Grove context has
      // `groveId: null`), so the mapping preserves the fail-closed contract.
      const rc = req.requestContext;
      principal = resolvePrincipal(
        {
          requestContext: rc
            ? {
                projectVaultDir: rc.projectVaultDir,
                projectId: rc.projectId ?? undefined,
                groveId: rc.groveId ?? undefined,
                machineId: rc.machineId ?? undefined,
                tenancySource: rc.tenancySource,
              }
            : undefined,
        },
        { machineId: deps.machineId },
      );
      authorize(principal);
    } catch (e) {
      if (e instanceof TenancyViolationError) {
        deps.logger.warn(LOG_KINDS.TENANCY_VIOLATION, 'Rejected request with invalid tenancy', {
          pathname: req.pathname,
          detail: e.detail,
        });
        return { status: 400, body: { ok: false, error: e.message, reason: 'tenancy-violation' } };
      }
      throw e;
    }
    return handler(req, principal);
  };
}
