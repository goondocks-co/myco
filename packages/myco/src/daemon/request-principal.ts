/**
 * The single resolver that turns a request into an authorized tenant
 * principal — and the one place the daemon decides a request is allowed to
 * act against a tenant vault.
 *
 * Why this exists: the global daemon is multi-tenant, and cross-tenant
 * leakage is the worst failure mode. The server synthesizes a fallback
 * (bootstrap-anchor) request context for EVERY request before handlers run
 * (server.ts:347), so "is requestContext present?" is always true and can
 * never be trusted as authorization. `tenancySource` (added upstream in
 * `grove/request-context.ts`) carries the provenance distinction through
 * transport: `'caller'` means the caller explicitly supplied project/grove
 * identity that survived the context-switch auth gate; `'synthesized'` means
 * the daemon's fallback. This resolver accepts only `'caller'` tenancy and
 * rejects synthesized tenancy loudly, making cross-tenant leakage impossible
 * by construction and noisy when attempted.
 */

import { isCallerTenancy, type TenancySource } from '@myco/grove/request-context.js';

// Branded types so the daemon's own home can never be used where a tenant
// vault is expected. A bare `string` cannot satisfy either brand; the only
// constructors are this module's resolver (for `ProjectVaultDir`, via a
// caller-authorized request context) and `daemonHome` (for `DaemonHome`).
declare const brand: unique symbol;
export type ProjectVaultDir = string & { readonly [brand]: 'ProjectVaultDir' };
export type DaemonHome = string & { readonly [brand]: 'DaemonHome' };

export interface Identity {
  readonly machineId: string;
  readonly userId: string | null;
}

export interface Tenancy {
  readonly projectVaultDir: ProjectVaultDir;
  readonly projectId: string;
  readonly groveId: string;
}

export interface RequestPrincipal {
  readonly identity: Identity;
  readonly tenancy: Tenancy;
}

/**
 * Thrown when a request's tenancy is absent OR was synthesized from the
 * daemon's fallback rather than supplied by the caller. Call sites at the
 * transport boundary translate this into a hard failure — the request must
 * never proceed against a tenant vault it was not authorized for.
 */
export class TenancyViolationError extends Error {
  constructor(public readonly detail: string) {
    super(`Tenancy violation: ${detail}`);
    this.name = 'TenancyViolationError';
  }
}

/**
 * Resolve a request into an authorized principal.
 *
 * Throws `TenancyViolationError` when tenancy is absent OR was synthesized
 * from the daemon fallback (presence is NOT authorization — server.ts:347
 * synthesizes a fallback context before handlers run).
 */
export function resolvePrincipal(
  req: {
    requestContext?: {
      projectVaultDir?: string;
      projectId?: string;
      groveId?: string;
      machineId?: string;
      tenancySource?: TenancySource;
    };
  },
  env: { machineId: string; userId?: string | null },
): RequestPrincipal {
  const rc = req.requestContext;
  if (!rc?.projectVaultDir || !rc.projectId || !rc.groveId) {
    throw new TenancyViolationError('missing project/grove on request');
  }
  if (!isCallerTenancy(rc)) {
    throw new TenancyViolationError(
      'tenancy synthesized from the daemon fallback, not caller-supplied',
    );
  }
  return {
    identity: { machineId: env.machineId, userId: env.userId ?? null },
    tenancy: {
      projectVaultDir: rc.projectVaultDir as ProjectVaultDir,
      projectId: rc.projectId,
      groveId: rc.groveId,
    },
  };
}

/**
 * Authorization seam: identity → permitted tenancy/scope. Allow-all for the
 * local single-machine principal today; the single place a future RBAC
 * policy plugs in. Throw `TenancyViolationError` on deny.
 */
export function authorize(_principal: RequestPrincipal): void {
  /* allow-all (local) */
}

/**
 * The ONLY constructor of a `DaemonHome` — daemon-internal bootstrap use
 * only, never a request tenant. Keeping the brand mintable in exactly one
 * place is what prevents the daemon's own home from being passed where a
 * tenant `ProjectVaultDir` is expected.
 */
export function daemonHome(path: string): DaemonHome {
  return path as DaemonHome;
}
