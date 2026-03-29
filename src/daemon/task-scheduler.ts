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
  /** Called to check if any agent is currently running. */
  isAgentRunning: () => boolean;
  /** Called to mark agent as running/not running. */
  setAgentRunning: (v: boolean) => void;
  /** Called to run the task. */
  runTask: (taskName: string) => Promise<void>;
  /** Pre-condition checkers keyed by preCondition name. */
  preConditions: Record<string, () => boolean>;
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
        if (context.isAgentRunning()) return;
        if (Date.now() - lastRun < intervalMs) return;

        // Check pre-condition if defined
        if (effective.preCondition) {
          const check = context.preConditions[effective.preCondition];
          if (!check) return; // Unknown pre-condition — don't run
          if (!check()) return;
        }

        try {
          context.setAgentRunning(true);
          await context.runTask(task.name);
          lastRun = Date.now();
        } finally {
          context.setAgentRunning(false);
        }
      },
    });
  }

  return jobs;
}
