import { getAtPath } from '../utils/dot-path.js';
import type { MycoConfig } from './schema.js';
import type { CapabilityId } from './scope.js';

/**
 * The declarative capability map — the single source for: which config leaves
 * a capability toggle flips, which scheduled tasks it governs, and where its
 * advanced settings live. Keep this current as cost-bearing features are
 * added; the capability sync test fails loudly if a gate path drifts from the
 * schema/registry.
 *
 * NOTE: `enabled`-style member gates that default ON are NOT listed as members
 * unless the toggle should explicitly flip them. The master gate is
 * authoritative at runtime (gate-honoring plan), so members are for UI grouping
 * + demote-clears-overrides, not for runtime suppression.
 */
export interface CapabilityDef {
  id: CapabilityId;
  /** Human label for badges + the capability panel. */
  label: string;
  /** Config leaf flipped to enable/disable the capability. */
  masterGate: string;
  /** Other config leaves this capability governs (UI grouping / demote). */
  memberGates: string[];
  /**
   * Agent task names this capability governs. May include scheduleless,
   * manual-only tasks — a scheduleless entry has zero scheduler effect and
   * only wires manual-dispatch gating (governingCapability/capabilityForTask).
   */
  scheduledTasks: string[];
  /** Settings route for advanced knobs (deep-linked from the panel; finalized in the UI plan). */
  advancedSettingsLink: string;
  /**
   * Resolution when the master-gate path is absent from the config. Existing
   * capabilities keep the implicit `true` (absent = enabled); OKF is the first
   * off-by-default capability. Runtime configs come from the merged loader,
   * which materializes every Zod default — so the schema's `.default(false)`
   * is the real off-by-default mechanism and this field is defense-in-depth
   * for raw/hand-built configs (spec-mandated).
   */
  defaultEnabled?: boolean;
}

export const CAPABILITIES: Record<CapabilityId, CapabilityDef> = {
  cortex: {
    id: 'cortex',
    label: 'Cortex',
    masterGate: 'cortex.enabled',
    memberGates: [],
    scheduledTasks: ['cortex-instructions'],
    advancedSettingsLink: '/settings#scheduled-tasks',
  },
  canopy: {
    id: 'canopy',
    label: 'Canopy',
    masterGate: 'cortex.canopy.enabled',
    memberGates: [],
    scheduledTasks: ['canopy-map', 'canopy-describe'],
    advancedSettingsLink: '/settings#scheduled-tasks',
  },
  skills: {
    id: 'skills',
    label: 'Skills',
    masterGate: 'skills.enabled',
    memberGates: [],
    scheduledTasks: ['skill-survey', 'skill-generate', 'skill-evolve'],
    advancedSettingsLink: '/settings#skills',
  },
  vault_evolution: {
    id: 'vault_evolution',
    label: 'Vault Evolution',
    masterGate: 'vault_evolution.enabled',
    memberGates: [],
    // vault-seed has no schedule block; listed here only for manual-dispatch gating.
    scheduledTasks: ['vault-evolve', 'vault-seed'],
    advancedSettingsLink: '/settings#scheduled-tasks',
  },
  okf: {
    id: 'okf',
    label: 'OKF',
    masterGate: 'okf.enabled',
    // Matches the universal precedent (all capabilities use []); the OKF page
    // owns the advanced knobs, so UI grouping via memberGates buys nothing.
    memberGates: [],
    scheduledTasks: ['okf-maintain'],
    advancedSettingsLink: '/okf',
    defaultEnabled: false,
  },
};

/** Resolve the capability that governs a given agent task name, or null. */
export function capabilityForTask(taskName: string): CapabilityId | null {
  for (const cap of Object.values(CAPABILITIES)) {
    if (cap.scheduledTasks.includes(taskName)) return cap.id;
  }
  return null;
}

export function governingCapability(taskName: string): CapabilityId | null {
  return capabilityForTask(taskName);
}

/**
 * Single authoritative capability gate. Fail-closed: a null/unloadable
 * config disables the capability. When the master-gate path is absent, the
 * capability's `defaultEnabled` decides — implicit `true` for the legacy
 * capabilities, `false` for OKF — matching the gate-honoring contract.
 */
export function capabilityEnabled(config: MycoConfig | null | undefined, capId: CapabilityId): boolean {
  if (!config) return false;
  const cap = CAPABILITIES[capId];
  const value = getAtPath(config, cap.masterGate);
  if (value === false) return false;
  if (value === true) return true;
  return cap.defaultEnabled ?? true;
}

/**
 * Single authority for scheduled-task effective enablement: a task runs only
 * when its governing capability is on and its schedule resolves enabled via
 * the same override-nullish-coalescing semantics as the scheduler
 * (`override ?? YAML default`). Callers pass the task definition's YAML
 * default so this module stays independent of task loading.
 */
export function effectiveTaskScheduleEnabled(
  config: MycoConfig | null | undefined,
  taskName: string,
  yamlScheduleEnabled: boolean,
): boolean {
  if (!config) return false;
  const capId = capabilityForTask(taskName);
  if (capId && !capabilityEnabled(config, capId)) return false;
  const override = config.agent.tasks?.[taskName]?.schedule?.enabled;
  return override ?? yamlScheduleEnabled;
}

/** All opt-in capabilities off → the project is capture-only. */
export function isCaptureOnly(config: MycoConfig | null | undefined): boolean {
  return (Object.keys(CAPABILITIES) as CapabilityId[]).every((id) => !capabilityEnabled(config, id));
}
