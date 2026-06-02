import type { MycoConfig } from '@myco/config/schema.js';
import { loadMergedConfig } from '@myco/config/loader.js';

/** Tenant identity bits needed to resolve the request grove's merged config. */
export interface TenantConfigSource {
  projectVaultDir?: string;
  groveId?: string | null;
}

/**
 * Resolve the merged config for a request's tenant. Falls back to `fallback`
 * (the daemon's liveConfig) only when no tenant context is resolvable — never
 * lets the daemon bootstrap-home config gate a tenant op.
 */
export function resolveTenantConfig(
  tenancy: TenantConfigSource | undefined,
  fallback: MycoConfig,
): MycoConfig {
  if (!tenancy?.projectVaultDir || !tenancy.groveId) return fallback;
  try {
    return loadMergedConfig(tenancy.projectVaultDir, { groveId: tenancy.groveId });
  } catch {
    return fallback;
  }
}
