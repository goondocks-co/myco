/**
 * What each retained intelligence task needs before it may run.
 *
 * The 1.4 vault carries a partial version of this inverted, as
 * `CapabilityDef.scheduledTasks` in `packages/myco/src/config/capabilities.ts`.
 * That field lists only SCHEDULED tasks and nothing reads it at runtime — it
 * groups the settings UI. Locally no agent task is refused on a capability at
 * all: capabilities gate features there, and a capture-only project is made by
 * `reseedCaptureOnly()` writing every master gate false at provision.
 *
 * A Deployment has no provisioning moment — a Project appears from a member's
 * first write — so admission has to be asked per run, and this is the table that
 * answers it. Two kinds of gate, and every retained task names one:
 *
 * - **A capability**, per Project, absent meaning not admitted.
 * - **A provider**, per Deployment, for the capture-driven tasks. A title and
 *   summary rides capture rather than an intelligence capability, and asks only
 *   whether there is a model to call — resolved task-first then default, as
 *   `hasConfiguredProvider` resolves it locally.
 */
import type { RunAdmissionGate } from './runs.js';

/** Every retained task, with the gate it runs behind. Canopy's tasks belong to the map task and are not here. */
export const TASK_ADMISSION: Readonly<Record<string, RunAdmissionGate>> = {
  'container-smoke': { kind: 'capability', capability: 'cortex' },
  'cortex-instructions': { kind: 'capability', capability: 'cortex' },
  'cortex-prompt-builder': { kind: 'capability', capability: 'cortex' },
  'digest-only': { kind: 'capability', capability: 'cortex' },

  'skill-survey': { kind: 'capability', capability: 'skills' },
  'skill-generate': { kind: 'capability', capability: 'skills' },
  'skill-evolve': { kind: 'capability', capability: 'skills' },

  'vault-evolve': { kind: 'capability', capability: 'vault_evolution' },
  'vault-seed': { kind: 'capability', capability: 'vault_evolution' },
  'supersession-sweep': { kind: 'capability', capability: 'vault_evolution' },
  'extract-only': { kind: 'capability', capability: 'vault_evolution' },
  'review-session': { kind: 'capability', capability: 'vault_evolution' },

  'title-summary': { kind: 'provider' },
};

export const RETAINED_TASKS = Object.keys(TASK_ADMISSION);

/** The states a scheduled task may run in, in the words the 1.4 task files use. */
export type ScheduleState = 'active' | 'idle' | 'sleep';

/**
 * When the clock runs a task. The shape is the 1.4 task file's `schedule`
 * block, carried field for field: interval, the states it runs in, a named
 * precondition, an accelerator that shortens the interval under backlog, a
 * per-day ceiling, and whether a cold Project still gets it. `overlap` is
 * the Deployment's own: a `skip` task never runs twice at once in a Project;
 * a `queue` task is dispatched and the queue holds it.
 */
export interface TaskSchedule {
  /** A schedule declared but switched off; absent means on. */
  enabled?: boolean;
  intervalSeconds: number;
  runIn: readonly ScheduleState[];
  preCondition?: string;
  accelerator?: { name: string; thresholds: { steady: number; accelerated: number } };
  maxRunsPerDay?: number;
  runWhenCold?: boolean;
  overlap: 'skip' | 'queue';
}

/**
 * What the Deployment schedules, by task. A task is scheduled here only once
 * the Deployment serves its tool surface; every other retained task is null
 * until its child turns it on, and copies the task file's block when it does.
 * `container-smoke` is the harness health probe the 1.4 daemon ran daily as
 * `harness-health`: one call, one report, proof the runtime still works.
 */
export const TASK_SCHEDULE: Readonly<Record<string, TaskSchedule | null>> = {
  'container-smoke': { intervalSeconds: 86_400, runIn: ['sleep'], overlap: 'skip', maxRunsPerDay: 2 },
  // Declared and switched off. 1.4 ran this every 8 hours against a local
  // model-agnostic vault; a Deployment run is a container and a frontier model,
  // so the cadence is daily and an owner turns it on after one measured run.
  // A dispatch whose input matches the artifact already written costs nothing,
  // which is what makes a daily interval safe once it is on.
  'cortex-instructions': { enabled: false, intervalSeconds: 86_400, runIn: ['sleep'], overlap: 'skip', maxRunsPerDay: 1 },
  'cortex-prompt-builder': null,
  'digest-only': null,
  'skill-survey': null,
  'skill-generate': null,
  'skill-evolve': null,
  'vault-evolve': null,
  'vault-seed': null,
  'supersession-sweep': null,
  'extract-only': null,
  'review-session': null,
  'title-summary': null,
};

/** Named preconditions a schedule may name; a task naming one absent here is refused by a gate, never skipped in silence. */
export const PRE_CONDITIONS: Readonly<Record<string, (args: { projectId: string }) => Promise<boolean>>> = {};

/** Named accelerators: a count of pending work that shortens a task's interval. None yet; the Canopy task brings the first. */
export const ACCELERATORS: Readonly<Record<string, (args: { projectId: string; limit: number }) => Promise<number>>> = {};

/**
 * The tasks a person asks for one at a time: they carry no schedule, and a
 * schedule appearing on one is a cost the Deployment would pay on the clock
 * without anyone deciding it should.
 */
export const MANUAL_ONLY_TASKS: readonly string[] = [
  'vault-seed',
  'digest-only',
  'extract-only',
  'supersession-sweep',
  'review-session',
  'cortex-prompt-builder',
];

/** The schedule block an owner set for one task, or undefined where they set none. */
export function scheduleOverride(task: string, overrides: Record<string, unknown>): unknown {
  const entry = overrides[task];
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>).schedule : undefined;
}

/**
 * Every task the clock schedules on this wake, with its schedule under the
 * owner's overrides.
 *
 * A declaration switched off is absent rather than visited and skipped: the
 * clock's list is what the Deployment actually runs, and an owner turns a
 * declared task on through `agent.tasks.<task>.schedule.enabled`.
 */
export function scheduledTasks(overrides: Record<string, unknown> = {}): Array<{ task: string; schedule: TaskSchedule }> {
  return Object.entries(TASK_SCHEDULE).flatMap(([task, declared]) => {
    if (declared === null) return [];
    const schedule = resolveSchedule(declared, scheduleOverride(task, overrides));
    return schedule.enabled === false ? [] : [{ task, schedule }];
  });
}

/**
 * A Deployment's per-task override laid over the declared schedule, field by
 * field. The accelerator is replaced whole: a name from one block paired with
 * thresholds from another would shorten the wrong interval.
 */
export function resolveSchedule(declared: TaskSchedule, override: unknown): TaskSchedule {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return declared;
  const o = override as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const states = (v: unknown): readonly ScheduleState[] | undefined =>
    (Array.isArray(v) && v.every((s) => s === 'active' || s === 'idle' || s === 'sleep') ? (v as ScheduleState[]) : undefined);
  const accelerator = (v: unknown): TaskSchedule['accelerator'] | undefined => {
    if (v === null || typeof v !== 'object') return undefined;
    const a = v as Record<string, unknown>;
    const t = a.thresholds as Record<string, unknown> | undefined;
    if (typeof a.name !== 'string' || t === undefined || num(t.steady) === undefined || num(t.accelerated) === undefined) return undefined;
    return { name: a.name, thresholds: { steady: num(t.steady)!, accelerated: num(t.accelerated)! } };
  };
  return {
    ...(typeof o.enabled === 'boolean' ? { enabled: o.enabled } : declared.enabled === undefined ? {} : { enabled: declared.enabled }),
    intervalSeconds: num(o.intervalSeconds) ?? declared.intervalSeconds,
    runIn: states(o.runIn) ?? declared.runIn,
    preCondition: typeof o.preCondition === 'string' ? o.preCondition : declared.preCondition,
    accelerator: accelerator(o.accelerator) ?? declared.accelerator,
    maxRunsPerDay: num(o.maxRunsPerDay) ?? declared.maxRunsPerDay,
    runWhenCold: typeof o.runWhenCold === 'boolean' ? o.runWhenCold : declared.runWhenCold,
    overlap: o.overlap === 'skip' || o.overlap === 'queue' ? o.overlap : declared.overlap,
  };
}

/** Tier divisors on the interval under backlog: 1× up to the steady threshold, 4× up to the accelerated one, 12× past it. */
export function effectiveIntervalSeconds(intervalSeconds: number, count: number | null, thresholds: { steady: number; accelerated: number } | undefined): number {
  if (count === null || thresholds === undefined) return intervalSeconds;
  if (count <= thresholds.steady) return intervalSeconds;
  if (count <= thresholds.accelerated) return Math.floor(intervalSeconds / 4);
  return Math.floor(intervalSeconds / 12);
}

/** The gate a task runs behind, or null for a name this Deployment does not serve. */
export function admissionForTask(taskName: string): RunAdmissionGate | null {
  return TASK_ADMISSION[taskName] ?? null;
}
