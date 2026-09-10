/**
 * Scheduled-task effective enablement for the 1.4 scheduler: a task runs only
 * when its governing capability is on and its schedule resolves enabled under
 * the same override-nullish-coalescing semantics the scheduler applies
 * (`override ?? YAML default`). The bundled task definitions supply the
 * defaults, so this lives in the agent tree beside them and the config layer
 * imports nothing from here.
 */
import { BUNDLED_AGENT_TASKS } from './definitions.generated.js';
import { capabilityEnabled, capabilityForTask } from '../config/capabilities.js';
import type { MycoConfig } from '../config/schema.js';

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

