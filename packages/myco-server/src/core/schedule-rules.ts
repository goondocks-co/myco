/**
 * The rules a task's schedule is read by: the Deployment's scheduling leaves,
 * each task's schedule under the owner's override, the named preconditions and
 * accelerators, and a member's day of runs by hand. The clock
 * (`scheduled-tasks.ts`) decides by them; the task descriptions and the preview
 * of a start by hand read them. Nothing here dispatches, so nothing here
 * reaches the dispatcher or the secret store.
 */
import type { RelationalStore, ServerEnv } from './adapters.js';
import { DEPLOYMENT_LEAF_SPECS, isScheduleCount, settingTexts, storedSettings } from './settings.js';
import { TASK_SCHEDULE, type ScheduleState, type TaskSchedule } from './jobs.js';
import { newestUnprocessedSession } from '../read/prompts.js';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { capturedSinceMap } from './canopy.js';

const DAY_MS = 86_400_000;

/** The 1.4 defaults for the recency gates, applied where the leaves are unset. */
export const COLD_PROJECT_THRESHOLD_DAYS_DEFAULT = 14;
export const ACTIVE_WINDOW_DAYS_DEFAULT = 14;

export interface ScheduleLeaves {
  enabled: boolean;
  coldThresholdDays: number;
  activeWindowDays: number;
  overrides: Record<string, unknown>;
  /** The code map's refresh as the clock runs it, and which parts of it a per-task override sets over the leaves. */
  mapRefresh: { enabled: boolean; intervalSeconds: number; overridden: { enabled: boolean; interval: boolean } };
}

const parse = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
};

/**
 * The code map's own refresh period in minutes, or undefined where none is stored. A stored period the rule refuses
 * keeps the map refreshing as near to it as the rule allows: a number is clamped into the bounds, and anything else
 * keeps the declared interval.
 */
async function mapPeriodMinutes(env: ServerEnv): Promise<number | undefined> {
  const leaf = 'cortex.canopy.refresh.background_period_minutes';
  const held = (await storedSettings(env.db, [leaf])).get(leaf);
  if (held === undefined) return undefined;
  if (held.violation === null) return held.value as number;
  const spec = DEPLOYMENT_LEAF_SPECS[leaf] as { min: number; max: number };
  return typeof held.value === 'number' && Number.isFinite(held.value) ? Math.min(spec.max, Math.max(spec.min, Math.floor(held.value))) : undefined;
}

/** The Deployment's scheduling leaves: off until the owner turns scheduling on. */
export async function scheduleLeaves(env: ServerEnv): Promise<ScheduleLeaves> {
  const mapEnabled = 'cortex.canopy.refresh.background_enabled';
  const byLeaf = await settingTexts(env.db, ['agent.scheduled_tasks_enabled', 'agent.cold_project_threshold_days', 'agent.scheduled_tasks_active_window_days', 'agent.tasks', mapEnabled]);
  const days = (leaf: string, fallback: number): number => {
    const v = parse(byLeaf.get(leaf));
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const overrides = parse(byLeaf.get('agent.tasks'));
  const tasks = overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides as Record<string, unknown> : {};
  // Unset, the map refresh is off and keeps the interval `TASK_SCHEDULE` declares.
  const enabled = parse(byLeaf.get(mapEnabled)) === true;
  const period = await mapPeriodMinutes(env);
  const mapOverride = tasks[MAP_TASK];
  const mapTask = mapOverride !== null && typeof mapOverride === 'object' && !Array.isArray(mapOverride) ? mapOverride as Record<string, unknown> : {};
  const configured = scheduleOverride(MAP_TASK, tasks);
  const mapSchedule = configured !== null && typeof configured === 'object' && !Array.isArray(configured) ? configured as Record<string, unknown> : {};
  tasks[MAP_TASK] = { ...mapTask, schedule: { ...(typeof period === 'number' ? { intervalSeconds: period * 60 } : {}), ...mapSchedule, enabled: enabled && mapSchedule.enabled !== false } };
  const map = scheduleFor(MAP_TASK, TASK_SCHEDULE[MAP_TASK]!, tasks);
  return {
    mapRefresh: { enabled: map.enabled !== false, intervalSeconds: map.intervalSeconds,
      overridden: { enabled: mapSchedule.enabled === false, interval: mapSchedule.intervalSeconds !== undefined } },
    enabled: parse(byLeaf.get('agent.scheduled_tasks_enabled')) === true,
    coldThresholdDays: days('agent.cold_project_threshold_days', COLD_PROJECT_THRESHOLD_DAYS_DEFAULT),
    activeWindowDays: days('agent.scheduled_tasks_active_window_days', ACTIVE_WINDOW_DAYS_DEFAULT),
    overrides: tasks,
  };
}

/** How many runs of a task a member who is not an admin may start by hand in a rolling day, where nothing else names a number. */
export const MEMBER_RUNS_PER_DAY_DEFAULT = 4;

/**
 * How many runs of `task` one member who is not an admin may start by hand in a rolling day, across every Project:
 * the owner's `memberRunsPerDay` for the task under `agent.tasks`, else `MEMBER_RUNS_PER_DAY_DEFAULT`. It is its own
 * number, never the clock's `maxRunsPerDay`: turning the clock down does not lock members out, and turning it up does
 * not widen every member's day. Runs the clock starts are never counted against it, nor a member's against the clock's.
 */
export async function memberRunsPerDay(env: ServerEnv, task: string): Promise<number> {
  const override = scheduleOverride(task, (await scheduleLeaves(env)).overrides);
  const given = override !== null && typeof override === 'object' && !Array.isArray(override) ? override as Record<string, unknown> : {};
  return isScheduleCount(given.memberRunsPerDay) ? given.memberRunsPerDay : MEMBER_RUNS_PER_DAY_DEFAULT;
}

/** The schedule a task runs on for this Deployment: the declared block under the owner's override. */
export function scheduleFor(task: string, declared: TaskSchedule, overrides: Record<string, unknown>): TaskSchedule {
  return resolveSchedule(declared, scheduleOverride(task, overrides));
}

/** Whether a completed, undeleted session has unread extraction material with every known transcript ready. */
export async function hasUnprocessedPrompts(db: RelationalStore, projectId: string): Promise<boolean> {
  return (await newestUnprocessedSession(db, { projectId })) !== null;
}

/**
 * Named preconditions a schedule may name; a task naming one absent here is
 * refused by a gate, never skipped in silence.
 *
 * A condition is asked with the store it is deciding over: a condition about a
 * Project's data has to read that data, and one that could not would be a
 * condition about nothing. It is handed the store rather than the Deployment —
 * deciding whether to run is a read, and the signature says so.
 *
 * A name here is owner-settable, so every lookup goes through `declared`: an
 * inherited member of `Object.prototype` is not a registration, and a schedule
 * naming one is refused like any other unknown name.
 */
type ScheduleCondition = (args: { db: RelationalStore; projectId: string; now: number }) => Promise<boolean>;

/** A scheduling condition carries the reader wording of the check it runs. */
const condition = (description: string, check: ScheduleCondition): ScheduleCondition & { description: string } => Object.assign(check, { description });

export const PRE_CONDITIONS: Readonly<Record<string, ScheduleCondition & { description: string }>> = {
  'has-unprocessed-prompts': condition('Only when unread prompts remain.', ({ db, projectId }) => hasUnprocessedPrompts(db, projectId)),
  'has-capture-since-map': condition('Only after new session material arrives.', ({ db, projectId }) => capturedSinceMap(db, { projectId })),
  'has-recent-live-prompts': condition('Only when recent live sessions have unread prompts.', async ({ db, projectId, now }) => {
    const session = await newestUnprocessedSession(db, { projectId });
    return session !== null && session.liveCapture === 1 && session.endedAt >= now - DAY_MS && session.endedAt <= now;
  }),
};

/** Named accelerators: a count of pending work that shortens a task's interval, read over the same store and looked up the same way. */
export const ACCELERATORS: Readonly<Record<string, (args: { db: RelationalStore; projectId: string; limit: number }) => Promise<number>>> = {};

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
  const reservedRunsPerDay = (v: unknown): TaskSchedule['reservedRunsPerDay'] | undefined => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const r = v as Record<string, unknown>;
    return typeof r.count === 'number' && Number.isSafeInteger(r.count) && r.count >= 0 && typeof r.preCondition === 'string'
      ? { count: r.count, preCondition: r.preCondition } : undefined;
  };
  return {
    ...(typeof o.enabled === 'boolean' ? { enabled: o.enabled } : declared.enabled === undefined ? {} : { enabled: declared.enabled }),
    intervalSeconds: num(o.intervalSeconds) ?? declared.intervalSeconds,
    runIn: states(o.runIn) ?? declared.runIn,
    preCondition: typeof o.preCondition === 'string' ? o.preCondition : declared.preCondition,
    accelerator: accelerator(o.accelerator) ?? declared.accelerator,
    maxRunsPerDay: (isScheduleCount(o.maxRunsPerDay) ? o.maxRunsPerDay : undefined) ?? declared.maxRunsPerDay,
    reservedRunsPerDay: reservedRunsPerDay(o.reservedRunsPerDay) ?? declared.reservedRunsPerDay,
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
