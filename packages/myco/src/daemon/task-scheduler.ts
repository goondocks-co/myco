/**
 * Dynamic PowerManager job registration from task schedule definitions.
 *
 * Reads all task definitions, overlays user config overrides, and builds
 * PowerJob entries for tasks with enabled schedules.
 */

import type { AgentTask, AcceleratorConfig, TaskSchedule } from '@myco/agent/types.js';
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
    // Accelerator is a single nested object — overrides replace it
    // wholesale. Partial overrides on thresholds/floor would let users
    // accidentally pair a name from YAML with a thresholds shape from a
    // different work unit; safer to require the whole object together
    // when a project wants to deviate.
    accelerator: configOverride.schedule.accelerator ?? yamlSchedule.accelerator,
  };
}

/**
 * Tier divisors (1× / 4× / 12×) applied to intervalSeconds based on
 * backlog size. See AcceleratorConfig in agent/schemas.ts for the
 * contract; PowerManager's tick rate is the real lower bound on
 * actual fire rate.
 */
export function computeEffectiveInterval(
  intervalSeconds: number,
  count: number,
  thresholds: AcceleratorConfig['thresholds'],
): number {
  if (count <= thresholds.steady) return intervalSeconds;
  if (count <= thresholds.accelerated) return Math.floor(intervalSeconds / 4);
  return Math.floor(intervalSeconds / 12);
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
   * Count functions keyed by accelerator name. Each function returns the
   * current backlog size for that work unit. Empty in tests that don't
   * exercise adaptive cadence — tasks without an accelerator are
   * unaffected. The thresholds and floor come from the task's YAML
   * config, not from here.
   */
  accelerators?: Record<string, (limit?: number) => number>;
  /**
   * Optional error sink for detached task runs. Because scheduled tasks are
   * kicked off without awaiting (so the PowerManager tick loop stays
   * responsive), unhandled rejections from `runTask` land here instead of
   * propagating through the tick.
   */
  onTaskError?: (taskName: string, err: unknown) => void;
}

/**
 * Imperative one-shot trigger for a scheduled task. Call from a known
 * reset event (initial populate, mass re-add) when waiting up to one
 * full interval before the next tick is too long. The kick is stored as
 * a per-task flag and consumed on the next compatible tick — the
 * existing PowerManager `runIn` and in-flight overlap guards still
 * apply, so a kick during an active session correctly defers to the
 * next idle/sleep tick instead of competing with the foreground agent.
 */
export interface ScheduledJobKicker {
  /**
   * Request that the named task run on the next compatible tick,
   * bypassing the interval gate. Idempotent — multiple kicks before the
   * tick fires collapse to a single run.
   */
  kick(taskName: string): void;
}

export interface ScheduledJobBuildResult {
  jobs: PowerJob[];
  kicker: ScheduledJobKicker;
}

/**
 * Build PowerManager jobs from task definitions + config overrides.
 * Returns only jobs for tasks with schedule.enabled = true (after
 * override merge), plus a kicker handle for imperative triggers.
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
): ScheduledJobBuildResult {
  const jobs: PowerJob[] = [];

  // Per-task "run on next compatible tick" flags. Consumed inside the
  // tick handler; setting the flag bypasses the interval gate but not
  // the in-flight or precondition guards.
  const kickRequested = new Set<string>();
  const kicker: ScheduledJobKicker = {
    kick(taskName: string) {
      kickRequested.add(taskName);
    },
  };

  for (const task of tasks) {
    if (!task.schedule) continue;

    const override = configOverrides[task.name] as { schedule?: Partial<TaskSchedule> } | undefined;
    const effective = resolveSchedule(task.schedule, override);

    if (!effective.enabled) continue;

    let lastRun = initialLastRuns?.[task.name] ?? 0;

    // Hold deep_sleep open while the accelerator reports pending work.
    // Without the hold, the daemon drifts into deep_sleep, the timer
    // stops, and the queue stalls until the user wakes the machine.
    // Same shape as the embedding reconciler hold in power-jobs.ts.
    const preventsDeepSleep: (() => boolean) | undefined =
      effective.accelerator
        ? () => {
            if (!context?.accelerators) return false;
            const countFn = context.accelerators[effective.accelerator!.name];
            if (!countFn) return false;
            try {
              return countFn(1) > 0;
            } catch {
              return false;
            }
          }
        : undefined;

    jobs.push({
      name: `scheduled:${task.name}`,
      runIn: effective.runIn,
      preventsDeepSleep,
      fn: async () => {
        if (!context) return;
        if (context.isTaskRunning(task.name)) return;

        // Imperative kick bypasses the interval gate. Consume the flag
        // here regardless of whether the run proceeds (the precondition
        // can still skip the run; we don't want a stuck kick perpetually
        // firing at every tick).
        const wasKicked = kickRequested.delete(task.name);

        if (!wasKicked) {
          let effectiveIntervalSeconds = effective.intervalSeconds;
          if (effective.accelerator && context.accelerators) {
            const countFn = context.accelerators[effective.accelerator.name];
            if (countFn) {
              const countLimit = effective.accelerator.thresholds.accelerated + 1;
              effectiveIntervalSeconds = computeEffectiveInterval(
                effective.intervalSeconds,
                countFn(countLimit),
                effective.accelerator.thresholds,
              );
            }
          }
          const intervalMs = effectiveIntervalSeconds * 1000;
          if (Date.now() - lastRun < intervalMs) return;
        }

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

  return { jobs, kicker };
}
