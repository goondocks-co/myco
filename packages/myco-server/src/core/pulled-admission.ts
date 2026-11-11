import type { RelationalStore } from './adapters.js';
import { dispatchLoad } from '../db/runs/live.js';
import { automaticFits } from '../db/runs/budget-policy.js';
import type { BudgetActivation } from '../db/meta/budget-activation.js';
import { heldBy, type DispatchLimits } from './limits.js';
import { reserveForStage } from './budget-policy.js';
import { estimateForClaim } from './budget-estimates.js';
import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';

/** Current capacity admission shared by pulled claims and work waiting for a machine. */
export async function pullCapacityAvailable(db: RelationalStore, task: string, limits: DispatchLimits, now: number): Promise<boolean> {
  return heldBy(await dispatchLoad(db, task, now), limits) === null;
}

/** Price a Project's selected execution through the claim estimator before admitting its stage. */
export async function pullBudgetAdmission(db: RelationalStore, input: {
  projectId: string; task: string; now: number; execution: { harness: string; profile: ExecutionProfile }; activation?: BudgetActivation;
}): Promise<{ fits: boolean; requiredUsd: number }> {
  const price = await estimateForClaim(db, input.projectId, input.task, input.execution.harness, input.execution.profile);
  const requiredUsd = price.estimate + reserveForStage(input.task);
  return { fits: await automaticFits(db, requiredUsd, input.now, 0, input.activation), requiredUsd };
}
