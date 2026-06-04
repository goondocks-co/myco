/**
 * Dynamic JobRunner job registration from task schedule definitions.
 *
 * Builds ONE RunnerJob whose tick visits each (grove, project) tuple a
 * single time and applies every schedulable task inside that loop. Each
 * task still keeps its own `runIn`, interval, accelerator, preCondition,
 * running flag, and last-run clock — the collapse is purely about not
 * re-iterating the (grove, project) registry once per task per tick.
 */

import type { AgentTask, AcceleratorConfig, TaskSchedule } from '@myco/agent/types.js';
import type { GroveProjectId } from '@myco/grove/ids.js';
import type { RegisteredProjectScope } from './scope-iteration.js';
import type { RunnerJob } from './job-runner.js';
import type { PowerState } from './power.js';

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
    // Accelerator overrides replace the whole nested object — partial
    // overrides on thresholds/floor would let users pair a name from
    // YAML with a thresholds shape from a different work unit.
    accelerator: configOverride.schedule.accelerator ?? yamlSchedule.accelerator,
    maxRunsPerDay: configOverride.schedule.maxRunsPerDay ?? yamlSchedule.maxRunsPerDay,
  };
}

/** Trailing-window length for `maxRunsPerDay` checks. Exported for tests. */
export const RUNS_PER_DAY_WINDOW_SECONDS = 24 * 60 * 60;

// Tier divisors (1× / 4× / 12×) applied to intervalSeconds based on backlog size.
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
  /**
   * Iterate every project the scheduler should consider on this tick.
   * Implementations typically wrap `forEachRegisteredProject` so DB
   * pinning + per-Grove `withDatabase` scoping work the same way as
   * the rest of the daemon's housekeeping fan-outs.
   */
  forEachProject: (visit: (scope: RegisteredProjectScope) => Promise<void> | void) => Promise<void>;
  /** Per-(grove, project, task) running flag. */
  isTaskRunning: (groveId: string, projectId: GroveProjectId, taskName: string) => boolean;
  setTaskRunning: (
    groveId: string,
    projectId: GroveProjectId,
    taskName: string,
    running: boolean,
  ) => void;
  /**
   * Resolve the project's current power state for `runIn` matching.
   * `holdDeepSleep=true` pins the project at `sleep` instead of dropping
   * to `deep_sleep` so accelerator-bound work drains while idle.
   */
  getProjectPowerState: (scope: RegisteredProjectScope, holdDeepSleep: boolean) => PowerState;
  /** Per-project task dispatcher. */
  runTask: (scope: RegisteredProjectScope, taskName: string) => Promise<void>;
  /**
   * Resolve the current tenant-scoped config for a task. The task YAML is a
   * built-in default; Grove/project settings decide whether that task is
   * enabled for this project.
   */
  getTaskConfig: (
    scope: RegisteredProjectScope,
    taskName: string,
  ) => { schedule?: Partial<TaskSchedule> } | undefined;
  /** Pre-condition checks scoped to a project. */
  preConditions: Record<string, (scope: RegisteredProjectScope) => boolean>;
  /** Backlog count functions keyed by accelerator name. */
  accelerators?: Record<string, (scope: RegisteredProjectScope, limit?: number) => number>;
  /**
   * Count completed-or-failed runs of `taskName` for `scope` within the
   * trailing `windowSeconds` window. Used to enforce the per-task
   * `maxRunsPerDay` ceiling. Implementations should round-trip through
   * the project's database so the count reflects on-disk truth, not the
   * in-memory `lastRun` map. Optional — when omitted, the ceiling is
   * silently skipped (no enforcement).
   */
  getRecentTaskRunCount?: (
    scope: RegisteredProjectScope,
    taskName: string,
    windowSeconds: number,
  ) => number;
  /** Detached-run error sink so the PowerManager tick stays responsive. */
  onTaskError?: (taskName: string, groveId: string, projectId: GroveProjectId, err: unknown) => void;
  /**
   * Lazy-seed lastRun for a (grove, project) tuple that wasn't present
   * in the boot-time seed. Called on first visit — guards against new
   * projects that appear after boot double-firing tasks they recently
   * completed before the daemon came up.
   */
  seedMissingLastRuns?: (scope: RegisteredProjectScope) => Map<string, number>;
}

/**
 * Imperative one-shot trigger for a scheduled task. Use from a known reset
 * event (initial populate, mass re-add) when the next tick is too late.
 *
 * `kick(name)` — broadcast: every project on the next tick consumes the bypass.
 * `kick(name, { groveId, projectId })` — single (grove, project) bypass.
 *
 * Per-(grove, project, task) kicks are stored as flags and consumed on the
 * next compatible tick. Existing PowerManager `runIn` and in-flight overlap
 * guards still apply.
 */
export interface ScheduledJobKicker {
  kick(taskName: string, target?: { groveId: string; projectId: GroveProjectId }): void;
}

export interface ScheduledJobBuildResult {
  jobs: RunnerJob[];
  kicker: ScheduledJobKicker;
}

/**
 * `initialLastRuns` is keyed by `${groveId}:${projectId}:${taskName}`.
 * Daemon restart can seed each tuple from the most recent agent_runs row
 * for that triple so warm projects don't double-fire on boot.
 */
export type ProjectTaskLastRunMap = Record<string, number>;

export function lastRunKey(
  groveId: string,
  projectId: GroveProjectId,
  taskName: string,
): string {
  return `${groveId}:${projectId}:${taskName}`;
}

const COLLAPSED_JOB_NAME = 'scheduled:tasks';

interface CompiledTask {
  task: AgentTask;
  yamlEffective: TaskSchedule;
}

/**
 * Build JobRunner jobs from task definitions. Returns one collapsed
 * RunnerJob plus a kicker; tenant-scoped config is resolved per project tick.
 */
export function buildScheduledJobs(
  tasks: AgentTask[],
  context: ScheduledJobContext,
  initialLastRuns?: ProjectTaskLastRunMap,
): ScheduledJobBuildResult {
  // Per-(grove, project, task) bypass + history state.
  const projectTaskKicks = new Set<string>();
  const broadcastKicks = new Set<string>();
  const projectLastRun = new Map<string, number>(
    initialLastRuns ? Object.entries(initialLastRuns) : [],
  );

  // (grove, project) tuples whose lastRun has been lazily re-seeded.
  // Bounded by registered project count.
  const seededProjects = new Set<string>();

  const kicker: ScheduledJobKicker = {
    kick(taskName, target) {
      if (target === undefined) {
        broadcastKicks.add(taskName);
      } else {
        projectTaskKicks.add(lastRunKey(target.groveId, target.projectId, taskName));
      }
    },
  };

  // Keep every task that has a YAML schedule. Whether it is enabled is
  // tenant-scoped, so the effective schedule is resolved inside the
  // per-project tick.
  const compiled: CompiledTask[] = [];
  for (const task of tasks) {
    if (!task.schedule) continue;
    const yamlEffective = resolveSchedule(task.schedule);
    compiled.push({ task, yamlEffective });
  }

  // No scheduled-capable tasks → no RunnerJob to register.
  if (compiled.length === 0) {
    return { jobs: [], kicker };
  }

  // The collapsed job runs in every schedulable state because individual
  // tasks filter on their own `effective.runIn` against the per-project
  // power state inside the loop.
  const allRunIn: PowerState[] = ['active', 'idle', 'sleep'];

  const job: RunnerJob = {
    name: COLLAPSED_JOB_NAME,
    runIn: allRunIn,
    kind: 'scheduler',
    // Real global canopy-pending hold probe is wired in a later task; this
    // stub compiles and never holds for now.
    hold: { pending: () => 0 },
    fn: async () => {
      // Snapshot broadcasts at tick entry so a kick mid-tick lands on the next pass.
      const broadcastSnapshot = new Set(broadcastKicks);

      await context.forEachProject(async (projectScope) => {
        const groveId = projectScope.grove.id;
        const projectId = projectScope.projectId;

        // Lazy-seed once per (grove, project) so projects that appear
        // post-boot don't double-fire on their first warm tick.
        const seedKey = `${groveId}:${projectId}`;
        if (context.seedMissingLastRuns && !seededProjects.has(seedKey)) {
          seededProjects.add(seedKey);
          const seeded = context.seedMissingLastRuns(projectScope);
          for (const [taskName, ms] of seeded) {
            const k = lastRunKey(groveId, projectId, taskName);
            if (!projectLastRun.has(k)) projectLastRun.set(k, ms);
          }
        }

        for (const { task, yamlEffective } of compiled) {
          const taskConfig = context.getTaskConfig(projectScope, task.name);
          const effective = task.schedule
            ? resolveSchedule(task.schedule, taskConfig)
            : yamlEffective;
          if (!effective.enabled) continue;

          if (context.isTaskRunning(groveId, projectId, task.name)) continue;

          const taskKey = lastRunKey(groveId, projectId, task.name);
          const projectKicked = projectTaskKicks.delete(taskKey);
          const bypassInterval = projectKicked || broadcastSnapshot.has(task.name);

          // Single accelerator-count read reused by both the interval
          // tier calculation and the deep-sleep hold.
          const acceleratorFn =
            effective.accelerator && context.accelerators
              ? context.accelerators[effective.accelerator.name]
              : undefined;
          let acceleratorCount: number | null = null;
          if (effective.accelerator && acceleratorFn) {
            try {
              acceleratorCount = acceleratorFn(
                projectScope,
                effective.accelerator.thresholds.accelerated + 1,
              );
            } catch {
              acceleratorCount = null;
            }
          }

          if (!bypassInterval) {
            const effectiveIntervalSeconds =
              effective.accelerator && acceleratorCount !== null
                ? computeEffectiveInterval(
                    effective.intervalSeconds,
                    acceleratorCount,
                    effective.accelerator.thresholds,
                  )
                : effective.intervalSeconds;
            const intervalMs = effectiveIntervalSeconds * 1000;
            const last = projectLastRun.get(taskKey) ?? 0;
            if (Date.now() - last < intervalMs) continue;
          }

          const holdDeepSleep = acceleratorCount !== null && acceleratorCount > 0;
          const projectState = context.getProjectPowerState(projectScope, holdDeepSleep);
          if (!(effective.runIn as readonly PowerState[]).includes(projectState)) continue;

          if (effective.preCondition) {
            const check = context.preConditions[effective.preCondition];
            if (!check) continue;
            if (!check(projectScope)) continue;
          }

          // Per-day ceiling. Bypass intentionally honors the ceiling — a
          // kick should bypass interval/accelerator throttling but not
          // the safety cap. Counter rounds the window relative to "now"
          // so a steady drip exits the window naturally instead of
          // requiring a calendar boundary.
          if (effective.maxRunsPerDay !== undefined && context.getRecentTaskRunCount) {
            try {
              const recent = context.getRecentTaskRunCount(
                projectScope,
                task.name,
                RUNS_PER_DAY_WINDOW_SECONDS,
              );
              if (recent >= effective.maxRunsPerDay) continue;
            } catch {
              // Counter failures are non-fatal; fall through and let
              // interval/accelerator throttling do its job. A persistent
              // count failure surfaces via the daemon log, not by halting
              // scheduling.
            }
          }

          // Detach the agent run so PowerManager tick stays responsive.
          // isTaskRunning above guards re-entry; lastRun is stamped before
          // dispatch so interval throttling stays correct even if the task
          // is still in flight on the next tick.
          context.setTaskRunning(groveId, projectId, task.name, true);
          projectLastRun.set(taskKey, Date.now());
          const ctx = context;
          void ctx
            .runTask(projectScope, task.name)
            .catch((err) => {
              ctx.onTaskError?.(task.name, groveId, projectId, err);
            })
            .finally(() => {
              ctx.setTaskRunning(groveId, projectId, task.name, false);
            });
        }
      });

      // Broadcast kicks are one-shot.
      for (const name of broadcastSnapshot) broadcastKicks.delete(name);
    },
  };

  return { jobs: [job], kicker };
}
