/**
 * The clock's own dispatches: every task the Deployment schedules, considered
 * for every Project it holds, on each wake.
 *
 * The gates run in the order the 1.4 daemon applied them — a Deployment-wide
 * switch, the Project's own recency, whether the task is already live, the
 * interval (shortened under backlog), the state the task runs in, a named
 * precondition, the per-day ceiling — and the dispatcher takes what passes,
 * launching or queueing as the limits say. Nothing here is held between
 * wakes: every gate reads its answer from the store, so a wake delivered
 * twice schedules nothing twice.
 *
 * A dispatch limit and a per-day ceiling answer differently, and the difference
 * is the point: a limit QUEUES, a ceiling REFUSES (`ceilingSkipId`).
 */
import type { RelationalStore, ServerEnv } from './adapters.js';
import { AlreadyRunning, dispatchPrepared, HARNESS_AGENT_ID, prepareDispatch, type LaunchSpec } from './harness.js';
import { buildTaskInput } from './task-inputs.js';
import type { PowerState } from './power.js';
import { ensureAgent, hasLiveTaskRun, INPUT_UNCHANGED, lastTaskEntryAt, projectAdmission, recordSkipped, taskEntriesSince } from './runs.js';
import { leafValues, type ProjectCapability } from './settings.js';
import { TASK_SCHEDULE, type ScheduleState, type TaskSchedule } from './jobs.js';
import { declared } from './declared.js';
import { admissionForTask, runTimeoutForTask } from './task-catalogue.js';
import { listProjects } from '../read/sessions.js';
import { listUnprocessedPrompts, newestUnprocessedSession } from '../read/prompts.js';
import { emit } from '../telemetry.js';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';

const DAY_MS = 86_400_000;

/**
 * A ceiling refuses dispatch until the trailing 24-hour window has room.
 * Refusals share an id keyed by project, task and the window's filling instant.
 * Separate episodes can fill on the same UTC day; one episode can span midnight.
 * Replaced entries affect the filling instant but not the count, so a replacement
 * can produce an additional refusal row during an episode.
 * A zero ceiling uses one id for a project and task with no prior entry.
 * Skipped rows are excluded from the ceiling count; task names contain no `_`.
 */
const NO_ENTRY = 0;
const ceilingSkipId = (projectId: string, task: string, filledAt: number | null): string =>
  `run_ceiling_${projectId}_${task}_${filledAt ?? NO_ENTRY}`;

/**
 * A skip the clock records, carrying the harness identity its row points at.
 *
 * A skipped run names the harness agent as every other run does, and that row is
 * a foreign key. A Deployment that has never dispatched holds no such row —
 * a ceiling of zero refuses before any dispatch can declare it — so the identity
 * is declared here where none exists. An owner's own registration of it keeps
 * every field: this declares, it never edits.
 */
async function recordClockSkip(env: ServerEnv, projectId: string, task: string, reason: string, id: string, now: number): Promise<void> {
  await ensureAgent(env.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: null, model: null, enabled: true }, now);
  await recordSkipped(env.db, { projectId }, { id, agentId: HARNESS_AGENT_ID, task, reason, at: now });
}

/** Who a scheduled run is attributed to: the Deployment's own clock. */
export const CLOCK_ACTOR = 'clock';
/** The 1.4 defaults for the recency gates, applied where the leaves are unset. */
export const COLD_PROJECT_THRESHOLD_DAYS_DEFAULT = 14;
export const ACTIVE_WINDOW_DAYS_DEFAULT = 14;

/** Why the clock left a task alone this wake; a ceiling met is recorded on a run row, the rest are told. */
export type ScheduleSkip = 'disabled' | 'already_running' | 'not_yet' | 'not_in_state' | 'precondition' | 'max_runs_per_day' | 'reserved_runs_per_day' | 'capability_off' | 'cold' | 'quiet' | 'refused' | 'input_unchanged' | 'uninstructed';

export interface ScheduleReport {
  /** Dispatches the clock made, launched or queued. */
  dispatched: number;
  /** Per-day ceilings met, each recorded as a skipped run. */
  skipped: number;
}

interface ScheduleLeaves {
  enabled: boolean;
  coldThresholdDays: number;
  activeWindowDays: number;
  overrides: Record<string, unknown>;
}

const parse = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
};

/** The Deployment's scheduling leaves: off until the owner turns scheduling on. */
export async function scheduleLeaves(env: ServerEnv): Promise<ScheduleLeaves> {
  const mapEnabled = 'cortex.canopy.refresh.background_enabled';
  const mapPeriod = 'cortex.canopy.refresh.background_period_minutes';
  const byLeaf = await leafValues(env.db, ['agent.scheduled_tasks_enabled', 'agent.cold_project_threshold_days', 'agent.scheduled_tasks_active_window_days', 'agent.tasks', mapEnabled, mapPeriod]);
  const days = (leaf: string, fallback: number): number => {
    const v = parse(byLeaf.get(leaf));
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const overrides = parse(byLeaf.get('agent.tasks'));
  const tasks = overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides as Record<string, unknown> : {};
  const enabled: unknown = byLeaf.has(mapEnabled) ? JSON.parse(byLeaf.get(mapEnabled)!) : true;
  const period: unknown = byLeaf.has(mapPeriod) ? JSON.parse(byLeaf.get(mapPeriod)!) : 60;
  if (typeof enabled !== 'boolean' || typeof period !== 'number' || !Number.isSafeInteger(period) || period < 1) throw new Error('Canopy refresh requires a boolean and a positive whole number of minutes.');
  const mapOverride = tasks[MAP_TASK];
  const mapTask = mapOverride !== null && typeof mapOverride === 'object' && !Array.isArray(mapOverride) ? mapOverride as Record<string, unknown> : {};
  const configured = scheduleOverride(MAP_TASK, tasks);
  const mapSchedule = configured !== null && typeof configured === 'object' && !Array.isArray(configured) ? configured as Record<string, unknown> : {};
  tasks[MAP_TASK] = { ...mapTask, schedule: { intervalSeconds: period * 60, ...mapSchedule, enabled: enabled && mapSchedule.enabled !== false } };
  return {
    enabled: parse(byLeaf.get('agent.scheduled_tasks_enabled')) === true,
    coldThresholdDays: days('agent.cold_project_threshold_days', COLD_PROJECT_THRESHOLD_DAYS_DEFAULT),
    activeWindowDays: days('agent.scheduled_tasks_active_window_days', ACTIVE_WINDOW_DAYS_DEFAULT),
    overrides: tasks,
  };
}

/** The schedule a task runs on for this Deployment: the declared block under the owner's override. */
export function scheduleFor(task: string, declared: TaskSchedule, overrides: Record<string, unknown>): TaskSchedule {
  return resolveSchedule(declared, scheduleOverride(task, overrides));
}

/**
 * Decide one task for one Project at this wake. Answers the skip by name,
 * or null when the task should be dispatched. Pure over the reads it makes.
 */
export async function decideTask(env: ServerEnv, projectId: string, lastReceivedAt: number | null, task: string, schedule: TaskSchedule, state: PowerState, leaves: ScheduleLeaves, now: number): Promise<ScheduleSkip | null> {
  const scope = { projectId };
  if (schedule.enabled === false) return 'disabled';
  if (lastReceivedAt === null || now - lastReceivedAt > leaves.activeWindowDays * DAY_MS) return 'quiet';
  if (schedule.runWhenCold !== true && now - lastReceivedAt > leaves.coldThresholdDays * DAY_MS) return 'cold';
  const gate = admissionForTask(task);
  if (gate?.kind === 'capability' && !(await projectAdmission(env.db, scope, gate.capability as ProjectCapability)).admitted) return 'capability_off';
  if (schedule.overlap === 'skip' && (await hasLiveTaskRun(env.db, scope, task))) return 'already_running';

  const accelerator = schedule.accelerator === undefined ? undefined : declared(ACCELERATORS, schedule.accelerator.name);
  const count = schedule.accelerator !== undefined && accelerator !== undefined
    ? await accelerator({ db: env.db, projectId, limit: schedule.accelerator.thresholds.accelerated + 1 })
    : null;
  const intervalMs = effectiveIntervalSeconds(schedule.intervalSeconds, count, schedule.accelerator?.thresholds) * 1000;
  const last = await lastTaskEntryAt(env.db, scope, task, CLOCK_ACTOR);
  if (last !== null && now - last < intervalMs) return 'not_yet';

  if (!(schedule.runIn as readonly string[]).includes(state)) return 'not_in_state';
  if (schedule.preCondition !== undefined) {
    const check = declared(PRE_CONDITIONS, schedule.preCondition);
    if (check === undefined || !(await check({ db: env.db, projectId, now }))) return 'precondition';
  }
  if (schedule.maxRunsPerDay !== undefined) {
    const used = await taskEntriesSince(env.db, scope, task, now - DAY_MS, CLOCK_ACTOR);
    if (used >= schedule.maxRunsPerDay) return 'max_runs_per_day';
    const reserve = schedule.reservedRunsPerDay;
    if (reserve !== undefined && used >= Math.max(0, schedule.maxRunsPerDay - reserve.count)) {
      const check = declared(PRE_CONDITIONS, reserve.preCondition);
      if (check === undefined || !(await check({ db: env.db, projectId, now }))) return 'reserved_runs_per_day';
    }
  }
  return null;
}

/**
 * One wake's scheduling. Every Project the Deployment holds is visited for
 * every scheduled task; a dispatch goes through the dispatcher like any other
 * and lands launched or queued. Deep sleep never reaches here: the tick runs
 * nothing at that depth.
 */
export async function runScheduledTasks(env: ServerEnv, state: PowerState, now: number, serverUrl: string): Promise<ScheduleReport> {
  const report: ScheduleReport = { dispatched: 0, skipped: 0 };
  const leaves = await scheduleLeaves(env);
  if (!leaves.enabled) return report;
  const tasks = scheduledTasks(leaves.overrides);
  if (tasks.length === 0) return report;
  for (const project of await listProjects(env.db)) {
    for (const { task, schedule } of tasks) {
      const skip = await decideTask(env, project.projectId, project.lastActivityAt, task, schedule, state, leaves, now);
      if (skip === 'max_runs_per_day' || skip === 'reserved_runs_per_day') {
        // The entry that filled the window names the episode; it cannot move while the window stays full.
        const filledAt = await lastTaskEntryAt(env.db, { projectId: project.projectId }, task, CLOCK_ACTOR);
        await recordClockSkip(env, project.projectId, task, skip, ceilingSkipId(project.projectId, task, filledAt) + (skip === 'reserved_runs_per_day' ? '_reserved' : ''), now);
        emit({ kind: 'task_skipped', task, projectId: project.projectId, skip });
        report.skipped += 1;
        continue;
      }
      if (skip !== null) {
        if (skip !== 'not_yet' && skip !== 'quiet') emit({ kind: 'task_skipped', task, projectId: project.projectId, skip });
        continue;
      }
      const prepared = await prepareDispatch(env, task, project.projectId);
      if (!prepared.ok) {
        emit({ kind: 'task_skipped', task, projectId: project.projectId, skip: 'refused', refusal: prepared.refusal });
        continue;
      }
      // A task whose prompt the server builds is compared against the artifact
      // it last wrote: a Project that has not moved leaves a skipped row naming
      // that, and no model is called.
      const built = await buildTaskInput(env, task, project.projectId, now);
      if (built !== null && built.unchanged) {
        await recordClockSkip(env, project.projectId, task, INPUT_UNCHANGED, `run_${crypto.randomUUID()}`, now);
        emit({ kind: 'task_skipped', task, projectId: project.projectId, skip: INPUT_UNCHANGED });
        report.skipped += 1;
        continue;
      }
      const input: Pick<LaunchSpec, 'instruction' | 'inputHash' | 'counts'> = built === null || built.unchanged
        ? {}
        : { instruction: built.input.instruction, inputHash: built.input.inputHash, counts: built.input.counts };
      try {
        // A skip-overlap task's write refuses beside another live run of it: two wakes deciding at once write one row.
        const budget = runTimeoutForTask(task);
        const outcome = await dispatchPrepared(env, prepared.prepared, {
          serverUrl, actor: CLOCK_ACTOR, ...input, ...(budget === null ? {} : { timeoutSeconds: budget }),
        }, now, { singleFlight: schedule.overlap === 'skip' });
        emit({ kind: 'task_scheduled', task, projectId: project.projectId, runId: outcome.runId, queued: outcome.queued });
        report.dispatched += 1;
      } catch (err) {
        if (!(err instanceof AlreadyRunning)) throw err;
        emit({ kind: 'task_skipped', task, projectId: project.projectId, skip: 'already_running' });
      }
    }
  }
  return report;
}

/**
 * Whether the Project holds a prompt extraction has not read yet.
 *
 * One row decides it: a task whose work is a backlog asks whether the backlog is
 * empty, and a page of one answers that without reading the rest. Prompts of a
 * session still in flight are not counted — the read's own default — so a live
 * session is extracted once it ends rather than while it is being written.
 */
export async function hasUnprocessedPrompts(db: RelationalStore, projectId: string): Promise<boolean> {
  return (await listUnprocessedPrompts(db, { projectId }, { limit: 1 })).rows.length > 0;
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
export const PRE_CONDITIONS: Readonly<Record<string, (args: { db: RelationalStore; projectId: string; now: number }) => Promise<boolean>>> = {
  'has-unprocessed-prompts': ({ db, projectId }) => hasUnprocessedPrompts(db, projectId),
  'has-recent-live-prompts': async ({ db, projectId, now }) => {
    const session = await newestUnprocessedSession(db, { projectId });
    return session !== null && session.liveCapture === 1 && session.endedAt >= now - DAY_MS && session.endedAt <= now;
  },
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
    maxRunsPerDay: num(o.maxRunsPerDay) ?? declared.maxRunsPerDay,
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
