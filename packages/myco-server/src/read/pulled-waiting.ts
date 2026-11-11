import type { ServerEnv } from '../core/adapters.js';
import { pulledStages, switchedOnStages, type PulledWait, type PulledWaitScope } from '../core/pulled-stages.js';
import { pullBudgetAdmission, pullCapacityAvailable } from '../core/pulled-admission.js';
import { readDispatchLimits } from '../core/limits.js';
import { fleetExecution } from '../core/fleet-execution.js';
import { recentWorkerReports } from '../core/worker-contacts.js';
import { claimSettings } from '../core/worker-selection.js';
import { estimateKey } from '../core/budget-estimates.js';
import { currentPulledBudgetHold } from '../db/runs/pulled-budget-hold.js';

/** Pulled work on this bounded Project page that is admitted now and has waited since its actual deadline. */
export async function readPulledWaiting(env: ServerEnv, scope: PulledWaitScope): Promise<(PulledWait & { task: string })[]> {
  if (scope.projects.length === 0) return [];
  const stages = await switchedOnStages(env.db, pulledStages());
  if (stages.length === 0) return [];
  const [limits, reports, settings, hold] = await Promise.all([readDispatchLimits(env), recentWorkerReports(env.db, scope.now), claimSettings(env),
    currentPulledBudgetHold(env.db, { levels: pulledStages().map(stage => stage.level), now: scope.now })]);
  const executions = new Map<string, Awaited<ReturnType<typeof fleetExecution>>['selected']>();
  const capacity = new Map<string, boolean>();
  const admitted = new Map<string, boolean>();
  const waiting = new Map<string, PulledWait & { task: string }>();
  for (const unpriced of [...stages].sort((a, b) => a.level - b.level)) {
    if (hold !== null && unpriced.level >= hold.level) continue;
    if (!executions.has(unpriced.task)) executions.set(unpriced.task, (await fleetExecution(env, unpriced.task, reports, settings)).selected);
    const execution = executions.get(unpriced.task)!;
    const stage = execution === null ? unpriced : unpriced.withEstimate?.(estimateKey(unpriced.task, execution.harness, execution.profile)) ?? unpriced;
    if (stage.waiting === undefined) continue;
    if (!capacity.has(stage.task)) capacity.set(stage.task, await pullCapacityAvailable(env.db, stage.task, limits, scope.now));
    if (!capacity.get(stage.task)) continue;
    for (const row of await stage.waiting(env.db, { ...scope, cutoff: scope.now })) {
      const key = `${row.projectId}:${stage.task}`;
      if (execution !== null) {
        if (!admitted.has(key)) admitted.set(key, (await pullBudgetAdmission(env.db, { projectId: row.projectId, task: stage.task, now: scope.now, execution })).fits);
        if (!admitted.get(key)) continue;
      }
      if (row.since > scope.cutoff) continue;
      const previous = waiting.get(key);
      if (previous === undefined || row.since < previous.since) waiting.set(key, { ...row, task: stage.task });
    }
  }
  return [...waiting.values()];
}
