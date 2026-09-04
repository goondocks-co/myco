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
 */
import type { ServerEnv } from './adapters.js';
import { AlreadyRunning, dispatchPrepared, HARNESS_AGENT_ID, INPUT_UNCHANGED, prepareDispatch, type LaunchSpec } from './harness.js';
import { buildTaskInput } from './task-inputs.js';
import type { PowerState } from './power.js';
import { hasLiveTaskRun, lastTaskEntryAt, projectAdmission, recordSkipped, taskEntriesSince } from './runs.js';
import { leafValues, type ProjectCapability } from './settings.js';
import { ACCELERATORS, admissionForTask, effectiveIntervalSeconds, PRE_CONDITIONS, resolveSchedule, scheduledTasks, scheduleOverride, type TaskSchedule } from './task-catalogue.js';
import { listProjects } from '../read/sessions.js';
import { emit } from '../telemetry.js';

const DAY_MS = 86_400_000;
/** Who a scheduled run is attributed to: the Deployment's own clock. */
export const CLOCK_ACTOR = 'clock';
/** The 1.4 defaults for the recency gates, applied where the leaves are unset. */
export const COLD_PROJECT_THRESHOLD_DAYS_DEFAULT = 14;
export const ACTIVE_WINDOW_DAYS_DEFAULT = 14;

/** Why the clock left a task alone this wake; a ceiling met is recorded on a run row, the rest are told. */
export type ScheduleSkip = 'disabled' | 'already_running' | 'not_yet' | 'not_in_state' | 'precondition' | 'max_runs_per_day' | 'capability_off' | 'cold' | 'quiet' | 'refused' | 'input_unchanged';

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
  const byLeaf = await leafValues(env.db, ['agent.scheduled_tasks_enabled', 'agent.cold_project_threshold_days', 'agent.scheduled_tasks_active_window_days', 'agent.tasks']);
  const days = (leaf: string, fallback: number): number => {
    const v = parse(byLeaf.get(leaf));
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const overrides = parse(byLeaf.get('agent.tasks'));
  return {
    enabled: parse(byLeaf.get('agent.scheduled_tasks_enabled')) === true,
    coldThresholdDays: days('agent.cold_project_threshold_days', COLD_PROJECT_THRESHOLD_DAYS_DEFAULT),
    activeWindowDays: days('agent.scheduled_tasks_active_window_days', ACTIVE_WINDOW_DAYS_DEFAULT),
    overrides: overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides) ? (overrides as Record<string, unknown>) : {},
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

  const accelerator = schedule.accelerator === undefined ? undefined : ACCELERATORS[schedule.accelerator.name];
  const count = schedule.accelerator !== undefined && accelerator !== undefined
    ? await accelerator({ projectId, limit: schedule.accelerator.thresholds.accelerated + 1 })
    : null;
  const intervalMs = effectiveIntervalSeconds(schedule.intervalSeconds, count, schedule.accelerator?.thresholds) * 1000;
  const last = await lastTaskEntryAt(env.db, scope, task);
  if (last !== null && now - last < intervalMs) return 'not_yet';

  if (!(schedule.runIn as readonly string[]).includes(state)) return 'not_in_state';
  if (schedule.preCondition !== undefined) {
    const check = PRE_CONDITIONS[schedule.preCondition];
    if (check === undefined || !(await check({ projectId }))) return 'precondition';
  }
  if (schedule.maxRunsPerDay !== undefined && (await taskEntriesSince(env.db, scope, task, now - DAY_MS)) >= schedule.maxRunsPerDay) return 'max_runs_per_day';
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
      if (skip === 'max_runs_per_day') {
        await recordSkipped(env.db, { projectId: project.projectId }, { id: `run_${crypto.randomUUID()}`, agentId: HARNESS_AGENT_ID, task, reason: skip, at: now });
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
        await recordSkipped(env.db, { projectId: project.projectId }, { id: `run_${crypto.randomUUID()}`, agentId: HARNESS_AGENT_ID, task, reason: INPUT_UNCHANGED, at: now });
        emit({ kind: 'task_skipped', task, projectId: project.projectId, skip: INPUT_UNCHANGED });
        report.skipped += 1;
        continue;
      }
      const input: Pick<LaunchSpec, 'instruction' | 'inputHash' | 'counts'> = built === null || built.unchanged
        ? {}
        : { instruction: built.input.instruction, inputHash: built.input.inputHash, counts: built.input.counts };
      try {
        // A skip-overlap task's write refuses beside another live run of it: two wakes deciding at once write one row.
        const outcome = await dispatchPrepared(env, prepared.prepared, { serverUrl, actor: CLOCK_ACTOR, ...input }, now, { singleFlight: schedule.overlap === 'skip' });
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
