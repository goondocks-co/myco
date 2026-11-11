import type { RelationalStore } from './adapters.js';
import { dispatchLoad } from '../db/runs/live.js';
import { automaticFits } from '../db/runs/budget-policy.js';
import type { BudgetActivation } from '../db/meta/budget-activation.js';
import { heldBy, type DispatchLimits } from './limits.js';
import { reserveForStage, seedForStage } from './budget-policy.js';

/** Current capacity admission shared by pulled claims and work waiting for a machine. */
export async function pullCapacityAvailable(db: RelationalStore, task: string, limits: DispatchLimits, now: number): Promise<boolean> {
  return heldBy(await dispatchLoad(db, task, now), limits) === null;
}

/** A pulled claim's budget admission; work without an execution yet uses the task's initial estimate. */
export function pullBudgetAvailable(db: RelationalStore, task: string, now: number, price: { estimate?: number; activation?: BudgetActivation } = {}): Promise<boolean> {
  return automaticFits(db, price.estimate ?? seedForStage(task), now, reserveForStage(task), price.activation);
}
