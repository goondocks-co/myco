import { enumerateLeafPaths } from './leaf-paths.js';

/** Config storage tiers, lowest → highest precedence. `local` = local.yaml
 *  (this project, this machine, not git-committed); UI labels it "Personal". */
export type Tier = 'machine' | 'grove' | 'project' | 'local';
export const TIER_PRECEDENCE: readonly Tier[] = ['machine', 'grove', 'project', 'local'];

export interface ScopeEntry {
  /** Canonical tier — where the default lives; shown as the UI default badge. */
  home: Tier;
  /** More-specific tiers that may override it (subset of tiers > home). */
  overridableBy: Tier[];
}

/**
 * SEED = current de-facto behavior (confirmed via spec review), plus the
 * update-channel correction (decision-46130740). Keys are leaf paths or block
 * prefixes (longest-prefix wins). Changing a row is the ONE place scope is
 * defined; merge + UI + validation follow. Task 4's sync test fails loudly for
 * any schema leaf this map miscovers, so treat that test as the safety net while
 * ratifying rows against the Zod tier schemas in schema.ts.
 */
export const SCOPE_REGISTRY: Record<string, ScopeEntry> = {
  // machine-only (locked)
  'capture': { home: 'machine', overridableBy: [] },
  'machine_id': { home: 'machine', overridableBy: [] },
  'daemon.stale_session_threshold_ms': { home: 'grove', overridableBy: [] },
  'daemon.log_level': { home: 'machine', overridableBy: [] },
  'daemon.log_retention_days': { home: 'machine', overridableBy: [] },
  'daemon.update_channel': { home: 'machine', overridableBy: [] }, // decision-46130740
  // machine + Personal (deliberate change — see spec §A1)
  'notifications': { home: 'machine', overridableBy: ['local'] },
  // grove (locked — existing invariants)
  'embedding': { home: 'grove', overridableBy: [] },
  'appearance': { home: 'grove', overridableBy: [] },
  'team': { home: 'grove', overridableBy: [] },
  // grove + Personal (seed = current cards — RATIFY, see note)
  'agent': { home: 'grove', overridableBy: ['local'] },
  'skills': { home: 'grove', overridableBy: ['local'] },
  'maintenance': { home: 'grove', overridableBy: ['local'] },
  'backup': { home: 'grove', overridableBy: ['local'] },
  // project + Personal
  'release_provenance': { home: 'project', overridableBy: ['local'] },
  'release_provenance.reconcile_interval_minutes': { home: 'grove', overridableBy: ['project', 'local'] },
  'cortex': { home: 'project', overridableBy: ['local'] },
  'symbionts': { home: 'project', overridableBy: ['local'] },
  // internal
  'version': { home: 'project', overridableBy: [] },
  'config_version': { home: 'project', overridableBy: [] },
};

const SORTED_KEYS = Object.keys(SCOPE_REGISTRY).sort((a, b) => b.length - a.length);

/** Longest-prefix match. Throws for an unknown path (caught by the sync test). */
export function scopePolicyForPath(path: string): ScopeEntry {
  for (const key of SORTED_KEYS) {
    if (path === key || path.startsWith(`${key}.`)) return SCOPE_REGISTRY[key];
  }
  throw new Error(`No scope registry entry for config path: ${path}`);
}

export function tierAllowsPath(tier: Tier, path: string): boolean {
  const e = scopePolicyForPath(path);
  return e.home === tier || e.overridableBy.includes(tier);
}

/** Return a copy of `raw` keeping only leaf paths this tier may contribute.
 *  Sparse: no defaults injected; unknown paths are dropped. */
export function pruneToTier(raw: Record<string, unknown>, tier: Tier): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const leaf of enumerateLeafPaths(raw)) {
    let allowed = false;
    try { allowed = tierAllowsPath(tier, leaf); } catch { allowed = false; }
    if (!allowed) continue;
    const parts = leaf.split('.');
    let src: any = raw, dst: any = out;
    for (let i = 0; i < parts.length - 1; i += 1) {
      src = src?.[parts[i]];
      dst[parts[i]] ??= {};
      dst = dst[parts[i]];
    }
    dst[parts[parts.length - 1]] = src?.[parts[parts.length - 1]];
  }
  return out;
}
