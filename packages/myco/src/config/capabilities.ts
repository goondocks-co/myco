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
  /** Agent task names this capability gates (consumed by the gate-honoring plan). */
  scheduledTasks: string[];
  /** Settings route for advanced knobs (deep-linked from the panel; finalized in the UI plan). */
  advancedSettingsLink: string;
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
    scheduledTasks: ['vault-evolve'],
    advancedSettingsLink: '/settings#scheduled-tasks',
  },
};

/** Resolve the capability that governs a given agent task name, or null. */
export function capabilityForTask(taskName: string): CapabilityId | null {
  for (const cap of Object.values(CAPABILITIES)) {
    if (cap.scheduledTasks.includes(taskName)) return cap.id;
  }
  return null;
}
