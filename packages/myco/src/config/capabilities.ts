import { getAtPath } from '../utils/dot-path.js';
import { BUNDLED_AGENT_TASKS } from '../agent/definitions.generated.js';
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
   * Resolution when the master-gate path is absent from the config. Every
   * current capability keeps the implicit `true` (absent = enabled); this
   * field exists for a future off-by-default capability. Runtime configs
   * come from the merged loader, which materializes every Zod default — so
   * a schema's `.default(false)` would be the real off-by-default mechanism
   * and this field is defense-in-depth for raw/hand-built configs.
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
 * capability's `defaultEnabled` decides — implicit `true` today for every
 * capability, matching the gate-honoring contract.
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
/**
 * Gate options sourced from the task definition's YAML schedule block.
 * Callers that hold a task definition (the scheduler iterating loaded
 * tasks, including user-authored ones) pass the flags explicitly; when
 * omitted, the bundled-task lookup below fills them in, so a caller that
 * forgets the argument cannot silently drop the gate for built-in tasks.
 */
export interface TaskScheduleGateOptions {
  /** Schedule requires an explicit per-task provider choice in config. */
  requiresTaskProvider?: boolean;
}

/**
 * Schedule-gate metadata for the bundled task definitions, keyed by task
 * name. Built once from `BUNDLED_AGENT_TASKS` (a pure generated literal —
 * importing it creates no runtime dependency on the task loader), so the
 * scheduler, the canopy pending-probe, and the config API all read the
 * same source instead of hand-maintaining mirrors of the YAML.
 */
const BUNDLED_TASK_SCHEDULE_GATES: ReadonlyMap<string, {
  requiresTaskProvider: boolean;
  scheduleEnabledByDefault: boolean;
  phaseNames: ReadonlySet<string>;
}> = new Map(
  BUNDLED_AGENT_TASKS.map((task) => [task.name, {
    requiresTaskProvider: task.schedule?.requiresTaskProvider === true,
    scheduleEnabledByDefault: task.schedule?.enabled === true,
    phaseNames: new Set((task.phases ?? []).map((phase) => phase.name)),
  }]),
);

/** Bundled-task schedule defaults, for callers without a loaded definition. */
export function bundledTaskScheduleDefaults(
  taskName: string,
): { requiresTaskProvider: boolean; scheduleEnabledByDefault: boolean } | undefined {
  const entry = BUNDLED_TASK_SCHEDULE_GATES.get(taskName);
  if (!entry) return undefined;
  return {
    requiresTaskProvider: entry.requiresTaskProvider,
    scheduleEnabledByDefault: entry.scheduleEnabledByDefault,
  };
}

/**
 * Whether config makes an explicit provider choice for this task: a
 * task-level `provider`, or a phase-level provider override on a phase
 * that actually exists on the task. Phase keys are validated against the
 * bundled definition's phase list — a typo'd or foreign phase key carries
 * a provider no run will ever resolve (the executor matches overrides by
 * exact phase name and then falls back to the global provider), so
 * counting it would satisfy the gate while the spend lands on the default
 * provider anyway. Unknown (non-bundled) tasks accept any phase key.
 */
export function taskHasExplicitProvider(
  // Structural view so grove-tier configs (a subset of MycoConfig) qualify.
  config: {
    agent?: {
      tasks?: Record<string, { provider?: unknown; phases?: Record<string, { provider?: unknown } | undefined> } | undefined>;
    };
  } | null | undefined,
  taskName: string,
): boolean {
  const taskConfig = config?.agent?.tasks?.[taskName];
  if (!taskConfig) return false;
  if (taskConfig.provider) return true;
  const knownPhases = BUNDLED_TASK_SCHEDULE_GATES.get(taskName)?.phaseNames;
  return Object.entries(taskConfig.phases ?? {}).some(([phaseName, phase]) =>
    phase?.provider && (knownPhases === undefined || knownPhases.has(phaseName)));
}

export function effectiveTaskScheduleEnabled(
  config: MycoConfig | null | undefined,
  taskName: string,
  yamlScheduleEnabled: boolean,
  gate?: TaskScheduleGateOptions,
): boolean {
  if (!config) return false;
  const capId = capabilityForTask(taskName);
  if (capId && !capabilityEnabled(config, capId)) return false;
  // The provider gate outranks even an explicit schedule.enabled override:
  // it also covers hand-edited configs that enable the schedule without a
  // provider choice. Explicit gate options win (they may describe a
  // user-authored task); the bundled lookup backstops omitted arguments.
  const requiresProvider = gate?.requiresTaskProvider
    ?? BUNDLED_TASK_SCHEDULE_GATES.get(taskName)?.requiresTaskProvider
    ?? false;
  if (requiresProvider && !taskHasExplicitProvider(config, taskName)) return false;
  const override = config.agent.tasks?.[taskName]?.schedule?.enabled;
  return override ?? yamlScheduleEnabled;
}

/** All opt-in capabilities off → the project is capture-only. */
export function isCaptureOnly(config: MycoConfig | null | undefined): boolean {
  return (Object.keys(CAPABILITIES) as CapabilityId[]).every((id) => !capabilityEnabled(config, id));
}
