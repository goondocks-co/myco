/**
 * Dynamic PowerManager job registration from task schedule definitions.
 *
 * Reads all task definitions, overlays user config overrides, and builds
 * PowerJob entries for tasks with enabled schedules.
 */

import type { AgentTask, TaskSchedule } from '@myco/agent/types.js';
import type { PowerJob } from './power.js';

/** Resolve effective schedule: YAML defaults + myco.yaml overrides. */
function resolveSchedule(
  yamlSchedule: TaskSchedule,
  configOverride?: { schedule?: Partial<TaskSchedule> },
): TaskSchedule {
  if (!configOverride?.schedule) return yamlSchedule;
  return {
    enabled: configOverride.schedule.enabled ?? yamlSchedule.enabled,
    intervalSeconds: configOverride.schedule.intervalSeconds ?? yamlSchedule.intervalSeconds,
    runIn: configOverride.schedule.runIn ?? yamlSchedule.runIn,
    preCondition: configOverride.schedule.preCondition ?? yamlSchedule.preCondition,
  };
}

export interface ScheduledJobContext {
  /** Check if a specific task is currently running. */
  isTaskRunning: (taskName: string) => boolean;
  /** Mark a task as running/not running. */
  setTaskRunning: (taskName: string, running: boolean) => void;
  /** Called to run the task. */
  runTask: (taskName: string) => Promise<void>;
  /** Pre-condition checkers keyed by preCondition name. */
  preConditions: Record<string, () => boolean>;
  /**
   * Optional error sink for detached task runs. Because scheduled tasks are
   * kicked off without awaiting (so the PowerManager tick loop stays
   * responsive), unhandled rejections from `runTask` land here instead of
   * propagating through the tick.
   */
  onTaskError?: (taskName: string, err: unknown) => void;
}

/**
 * Build PowerManager jobs from task definitions + config overrides.
 *
 * Returns only jobs for tasks with schedule.enabled = true (after override merge).
 * Each job respects its own interval, runIn states, and optional pre-condition.
 *
 * @param tasks — All loaded agent tasks (built-in + user).
 * @param configOverrides — Per-task config from myco.yaml `agent.tasks`.
 * @param context — Runtime context for agent execution. Optional for testing.
 * @param initialLastRuns — Map of task name → epoch ms of last completed run (for restart seeding).
 */
export function buildScheduledJobs(
  tasks: AgentTask[],
  configOverrides: Record<string, unknown>,
  context?: ScheduledJobContext,
  initialLastRuns?: Record<string, number>,
): PowerJob[] {
  const jobs: PowerJob[] = [];

  for (const task of tasks) {
    if (!task.schedule) continue;

    const override = configOverrides[task.name] as { schedule?: Partial<TaskSchedule> } | undefined;
    const effective = resolveSchedule(task.schedule, override);

    if (!effective.enabled) continue;

    let lastRun = initialLastRuns?.[task.name] ?? 0;
    const intervalMs = effective.intervalSeconds * 1000;

    jobs.push({
      name: `scheduled:${task.name}`,
      runIn: effective.runIn,
      fn: async () => {
        if (!context) return;
        if (context.isTaskRunning(task.name)) return;
        if (Date.now() - lastRun < intervalMs) return;

        // Check pre-condition if defined
        if (effective.preCondition) {
          const check = context.preConditions[effective.preCondition];
          if (!check) return; // Unknown pre-condition — don't run
          if (!check()) return;
        }

        // Kick off the task detached from the PowerManager tick loop.
        // Scheduled agent runs can take 20+ minutes; awaiting them inside
        // the tick would starve every other power job (team-sync-flush,
        // embedding-reconcile, session-maintenance) for the duration.
        // Re-entry is prevented by the isTaskRunning check above, and
        // lastRun is stamped before dispatch so interval throttling stays
        // correct even if the task is still in flight on the next tick.
        const ctx = context;
        ctx.setTaskRunning(task.name, true);
        lastRun = Date.now();

        void ctx.runTask(task.name)
          .catch((err) => {
            ctx.onTaskError?.(task.name, err);
          })
          .finally(() => {
            ctx.setTaskRunning(task.name, false);
          });
      },
    });
  }

  return jobs;
}
