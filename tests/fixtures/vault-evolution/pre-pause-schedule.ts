import { EXTRACTION_TASK, SEEDING_TASK, TITLING_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { isScheduleCount } from './pre-pause-settings.js';

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
  /** Daily automatic extraction slots while the first eligible history partition is ramping. */
  rampRunsPerDay?: number;
  /** Daily automatic slots available only when the named condition passes. */
  reservedRunsPerDay?: { count: number; preCondition: string };
  runWhenCold?: boolean;
  overlap: 'skip' | 'queue';
}

/**
 * What the Deployment schedules, by task. A task is scheduled here only once
 * the Deployment serves its tool surface; every other retained task is null
 * until its child turns it on, and copies the task file's block when it does.
 * The retained container probe has no schedule on a 2.0 Deployment.
 */
export const TASK_SCHEDULE: Readonly<Record<string, TaskSchedule | null>> = {
  [MAP_TASK]: { enabled: false, intervalSeconds: 21_600, runIn: ['idle', 'sleep'], overlap: 'skip', maxRunsPerDay: 4, preCondition: 'has-capture-since-map' },
  'embedding-reconcile': null,
  [EXTRACTION_TASK]: { intervalSeconds: 3600, runIn: ['idle', 'sleep'], overlap: 'skip', maxRunsPerDay: 12, rampRunsPerDay: 2, reservedRunsPerDay: { count: 3, preCondition: 'has-recent-live-prompts' }, preCondition: 'has-unprocessed-prompts' },
  [SEEDING_TASK]: null,
  [TITLING_TASK]: null,
};


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
  const reservedRunsPerDay = (v: unknown): TaskSchedule['reservedRunsPerDay'] | undefined => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const r = v as Record<string, unknown>;
    return typeof r.count === 'number' && Number.isSafeInteger(r.count) && r.count >= 0 && typeof r.preCondition === 'string'
      ? { count: r.count, preCondition: r.preCondition } : undefined;
  };
  const storedCap = num(o.maxRunsPerDay);
  const wholeCap = storedCap === undefined ? undefined : Math.floor(storedCap);
  return {
    ...(typeof o.enabled === 'boolean' ? { enabled: o.enabled } : declared.enabled === undefined ? {} : { enabled: declared.enabled }),
    intervalSeconds: num(o.intervalSeconds) ?? declared.intervalSeconds,
    runIn: states(o.runIn) ?? declared.runIn,
    preCondition: typeof o.preCondition === 'string' ? o.preCondition : declared.preCondition,
    accelerator: accelerator(o.accelerator) ?? declared.accelerator,
    maxRunsPerDay: (isScheduleCount(wholeCap) ? wholeCap : undefined) ?? declared.maxRunsPerDay,
    rampRunsPerDay: (isScheduleCount(o.rampRunsPerDay) ? o.rampRunsPerDay : undefined) ?? declared.rampRunsPerDay,
    reservedRunsPerDay: reservedRunsPerDay(o.reservedRunsPerDay) ?? declared.reservedRunsPerDay,
    runWhenCold: typeof o.runWhenCold === 'boolean' ? o.runWhenCold : declared.runWhenCold,
    overlap: o.overlap === 'skip' || o.overlap === 'queue' ? o.overlap : declared.overlap,
  };
}
