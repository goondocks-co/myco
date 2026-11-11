import type { ServerEnv } from '../core/adapters.js';
import { pulledStages, switchedOnStages, type PulledWait, type PulledWaitScope } from '../core/pulled-stages.js';
import { pullBudgetAvailable, pullCapacityAvailable } from '../core/pulled-admission.js';
import { readDispatchLimits } from '../core/limits.js';

/** Pulled work on this bounded Project page that is admitted now and has waited since its actual deadline. */
export async function readPulledWaiting(env: Pick<ServerEnv, 'db' | 'fleet'>, scope: PulledWaitScope): Promise<(PulledWait & { task: string })[]> {
  if (scope.projects.length === 0) return [];
  const stages = await switchedOnStages(env.db, pulledStages());
  if (stages.length === 0) return [];
  const limits = await readDispatchLimits(env);
  const admitted = new Map<string, boolean>();
  const waiting = new Map<string, PulledWait & { task: string }>();
  for (const stage of stages) {
    if (stage.waiting === undefined) continue;
    if (!admitted.has(stage.task)) admitted.set(stage.task,
      await pullCapacityAvailable(env.db, stage.task, limits, scope.now) && await pullBudgetAvailable(env.db, stage.task, scope.now));
    if (!admitted.get(stage.task)) continue;
    for (const row of await stage.waiting(env.db, scope)) {
      const key = `${row.projectId}:${stage.task}`;
      const previous = waiting.get(key);
      if (previous === undefined || row.since < previous.since) waiting.set(key, { ...row, task: stage.task });
    }
  }
  return [...waiting.values()];
}
