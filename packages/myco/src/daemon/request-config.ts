import type { MycoConfig } from '@myco/config/schema.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { Logger } from './logger.js';

/** Tenant identity bits needed to resolve the request grove's merged config. */
export interface TenantConfigSource {
  projectVaultDir?: string;
  groveId?: string | null;
}

export interface ResolveTenantConfigOptions {
  /**
   * When present, a config-load FAILURE for a resolvable tenant is logged as a
   * warning (the daemon op still falls back — see below). Thread the
   * request-scoped logger so the failure is observable instead of silent.
   */
  logger?: Logger;
}

/**
 * Resolve the merged config for a request's tenant. Falls back to `fallback`
 * (the daemon's liveConfig) only when no tenant context is resolvable — never
 * lets the daemon bootstrap-home config gate a tenant op.
 *
 * Two distinct fallbacks share the same return value but mean different things:
 *   1. ABSENT tenancy (no projectVaultDir / no groveId) — legitimate, silent.
 *      This is the "no tenant context resolvable" case the docstring promises.
 *   2. PRESENT tenancy whose config FAILS to load (corrupt yaml, schema drift,
 *      not-found) — a real fault. Returning the daemon fallback silently here
 *      would be indistinguishable from case 1 and violate the branch's
 *      "fail closed + loud" tenet. So we emit a WARNING (carrying groveId +
 *      projectVaultDir + error) and STILL return `fallback` — loud in logs,
 *      not "crash the request": the daemon op stays resilient.
 */
export function resolveTenantConfig(
  tenancy: TenantConfigSource | undefined,
  fallback: MycoConfig,
  opts?: ResolveTenantConfigOptions,
): MycoConfig {
  // Absent tenancy — the legitimate, silent fallback. Returns BEFORE the try,
  // so the catch below only ever runs for a tenancy that WAS present.
  if (!tenancy?.projectVaultDir || !tenancy.groveId) return fallback;
  try {
    return loadMergedConfig(tenancy.projectVaultDir, { groveId: tenancy.groveId });
  } catch (err) {
    opts?.logger?.warn(
      LOG_KINDS.DAEMON_CONFIG,
      'resolveTenantConfig: failed to load tenant config; falling back to daemon config',
      {
        grove_id: tenancy.groveId,
        project_vault_dir: tenancy.projectVaultDir,
        error: String(err),
      },
    );
    return fallback;
  }
}
