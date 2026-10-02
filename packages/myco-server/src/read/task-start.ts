/**
 * What starting one task by hand in one Project would do right now, read before
 * anything is dispatched: the agent and model a claim would resolve for it, or
 * what a queued run of it would wait for; whether the task's own condition for
 * running holds there; whether one is already waiting or running; and whether
 * the Project has turned its capability on. Every answer comes from the
 * function the dispatch, the clock or the claim decides by, never a copy.
 */
import type { ReasoningTier } from '@goondocks/myco-shared/execution-profile';
import type { ServerEnv } from '../core/adapters.js';
import { declared } from '../core/declared.js';
import { capabilityOf, capabilityOn, previewExecution } from '../core/harness.js';
import { TASK_SCHEDULE } from '../core/jobs.js';
import { hasLiveTaskRun } from '../core/runs.js';
import { PRE_CONDITIONS, scheduleFor, scheduleLeaves } from '../core/scheduled-tasks.js';

export interface TaskStartPreview {
  task: string;
  projectId: string;
  /** The agent, tier, model and effort the first able worker would run it with; null when none could take it now. */
  execution: { harness: string; tier: ReasoningTier; model: string; effort: string | null } | null;
  /** What a queued run would wait under while no worker can take it, in the `run-holds` holder vocabulary; null when one can. */
  heldBy: string | null;
  /** How many workers have been heard from lately. */
  workers: number;
  /** The task's scheduling condition and whether it holds in the Project now; null for a task that names none. */
  readiness: { condition: string; met: boolean } | null;
  /** A run of the task is already waiting or running in the Project. */
  live: boolean;
  /** The capability the task needs and whether the Project has it on; null for a task no capability gates. */
  capability: { name: string; on: boolean } | null;
}

/** Preview one task in one Project the caller may read. */
export async function readTaskStartPreview(env: ServerEnv, projectId: string, task: string, now: number): Promise<TaskStartPreview> {
  const declaredSchedule = TASK_SCHEDULE[task] ?? null;
  const capability = capabilityOf(task);
  const [preview, leaves, live, on] = await Promise.all([
    previewExecution(env, task, now),
    declaredSchedule === null ? Promise.resolve(null) : scheduleLeaves(env),
    hasLiveTaskRun(env.db, { projectId }, task),
    capability === null ? Promise.resolve(null) : capabilityOn(env.db, projectId, capability),
  ]);
  const condition = declaredSchedule === null || leaves === null ? undefined : scheduleFor(task, declaredSchedule, leaves.overrides).preCondition;
  const check = condition === undefined ? undefined : declared(PRE_CONDITIONS, condition);
  const readiness = condition === undefined || check === undefined ? null : { condition, met: await check({ db: env.db, projectId, now }) };
  const { execution } = preview;
  return {
    task, projectId,
    execution: execution === null ? null : { harness: execution.harness, tier: execution.profile.tier, model: execution.profile.model, effort: execution.profile.effort },
    heldBy: preview.heldBy, workers: preview.workers, readiness, live,
    capability: capability === null || on === null ? null : { name: capability, on },
  };
}
