import { enumerateLeafPaths } from './leaf-paths.js';

/** Config storage tiers, lowest → highest precedence. `local` = local.yaml
 *  (this project, this machine, not git-committed); UI labels it "Personal". */
export type Tier = 'machine' | 'grove' | 'project' | 'local';
export const TIER_PRECEDENCE: readonly Tier[] = ['machine', 'grove', 'project', 'local'];

/** The opt-in per-project capabilities. A capability is a master config gate
 *  plus the settings it governs (declared in `capabilities.ts`). */
export const CAPABILITY_IDS = ['cortex', 'canopy', 'skills', 'vault_evolution'] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface ScopeEntry {
  /** Canonical tier — where the default lives; shown as the UI default badge. */
  home: Tier;
  /** More-specific tiers that may override it (subset of tiers > home). */
  overridableBy: Tier[];
  /** Capability this setting belongs to, if any. Used by the capability
   *  toggles + the sync test; absent for settings outside any capability. */
  gate?: CapabilityId;
}

/**
 * Config scope registry.
 *
 * Keys are leaf paths or block prefixes (longest-prefix wins). This is the
 * single source of truth for config scope; merge, UI, and validation should
 * follow it. The scope-registry sync test fails loudly for schema leaves this
 * map misses, so ratify changes against the Zod tier schemas in schema.ts.
 */
export const SCOPE_REGISTRY: Record<string, ScopeEntry> = {
  // machine-only (locked)
  'capture': { home: 'machine', overridableBy: [] },
  'machine_id': { home: 'machine', overridableBy: [] },
  'daemon.stale_session_threshold_ms': { home: 'grove', overridableBy: [] },
  'daemon.log_level': { home: 'machine', overridableBy: [] },
  'daemon.log_retention_days': { home: 'machine', overridableBy: [] },
  'daemon.update_channel': { home: 'machine', overridableBy: [] },
  // Legacy `update.channel` leaf. Runtime reads/writes machine
  // `daemon.update_channel` exclusively, and the loader lifts any legacy
  // `update.channel` from myco.yaml or local.yaml to machine once, then strips
  // it. `UpdateSchema` stays in MycoConfigSchema for compatibility, so this
  // bridge row keeps scope-registry-sync coverage aligned with the canonical
  // sibling.
  'update.channel': { home: 'machine', overridableBy: [] },
  // machine + Personal (deliberate change — see spec §A1)
  'notifications': { home: 'machine', overridableBy: ['local'] },
  // grove (locked — existing invariants)
  'embedding': { home: 'grove', overridableBy: [] },
  'appearance': { home: 'grove', overridableBy: [] },
  'team': { home: 'grove', overridableBy: [] },
  // grove + Personal (seed = current cards — RATIFY, see note)
  'agent': { home: 'grove', overridableBy: ['local'] },
  // Agent task-enablement toggles are Grove-locked: each Grove opts its whole
  // task pipeline in once; no per-machine Personal override (matches the old
  // UI's allowPersonal={false} on both). Specific leaves win via longest-prefix
  // over the `agent` block.
  'agent.scheduled_tasks_enabled': { home: 'grove', overridableBy: [] },
  'agent.event_tasks_enabled': { home: 'grove', overridableBy: [] },
  'agent.run_retention_days': { home: 'grove', overridableBy: [] },
  'skills': { home: 'grove', overridableBy: ['local'], gate: 'skills' },
  // Vault-Evolution capability master gate. Grove-tier home, per-project
  // Personal override so a project can be promoted/demoted on this machine.
  'vault_evolution': { home: 'grove', overridableBy: ['local'], gate: 'vault_evolution' },
  'maintenance': { home: 'grove', overridableBy: ['local'] },
  // backup is a Grove-level resource: the Grove is a DB boundary and one
  // project sets the backup for the ENTIRE Grove, so a per-project/per-machine
  // Personal override is meaningless. (The old UI's backup.dir
  // defaultScope="local" was wrong; grove-only is correct.)
  'backup': { home: 'grove', overridableBy: [] },
  // project (locked — the old UI used lockScope="project" on every release
  // field; project-level overrides are a future opt-in, not now). The
  // reconcile-interval leaf is the one exception below.
  'release_provenance': { home: 'project', overridableBy: [] },
  'release_provenance.reconcile_interval_minutes': { home: 'grove', overridableBy: ['project', 'local'] },
  'cortex': { home: 'project', overridableBy: ['local'], gate: 'cortex' },
  // Canopy splits out of the cortex block via a longer prefix (longest-prefix
  // match wins, same pattern as agent.scheduled_tasks_enabled over `agent`).
  'cortex.canopy': { home: 'project', overridableBy: ['local'], gate: 'canopy' },
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

/** Unknown paths already warned about — one stderr line per path per process. */
const warnedUnknownPaths = new Set<string>();

/** Return a copy of `raw` keeping only leaf paths this tier may contribute.
 *  Sparse: no defaults injected; unknown paths are dropped (fail-closed),
 *  with a one-time stderr warning per path so the drop is observable. */
export function pruneToTier(raw: Record<string, unknown>, tier: Tier): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const leaf of enumerateLeafPaths(raw)) {
    let allowed = false;
    try {
      allowed = tierAllowsPath(tier, leaf);
    } catch {
      if (!warnedUnknownPaths.has(leaf)) {
        warnedUnknownPaths.add(leaf);
        process.stderr.write(`[myco config] Unknown config path "${leaf}" has no scope registry entry; dropping it from the ${tier} tier\n`);
      }
    }
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
