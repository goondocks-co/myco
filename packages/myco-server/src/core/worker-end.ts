import { WorkerAccountingSchema, type WorkerUsage } from '@goondocks/myco-shared/worker-usage';
import { MAX_RUN_ERROR_CHARS } from '../constants.js';
import { resolveCost } from './cost/resolver.js';
import { runCloseRefusal } from './run-postconditions.js';
import type { RunUpdate } from './runs.js';
import { withLeasedRun, type WorkerRunIdentity } from './worker-run.js';

interface WorkerEnd extends WorkerRunIdentity {
  status: 'completed' | 'failed';
  error?: string | null;
  usage?: WorkerUsage | null;
}

/** Close evidence and accounting are prepared under the same dispatched attempt. */
export const prepareWorkerEnd = withLeasedRun(async (env, _worker, run: WorkerEnd, row) => {
  const { usage = null, attemptId } = WorkerAccountingSchema.parse(run);
  const unmet = run.status === 'completed' ? await runCloseRefusal(env.db, { projectId: run.projectId }, row) : null;
  const status = unmet === null ? run.status : 'failed';
  const error = unmet ?? (run.error == null ? null : run.error.slice(0, MAX_RUN_ERROR_CHARS));
  const cost = await resolveCost({
    harness: '', model: '',
    usage: usage === null ? {} : Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== null)),
  });
  const accounting: RunUpdate = attemptId === undefined ? {} : {
    usage_data: usage === null ? null : JSON.stringify(usage),
    tokens_used: usage?.inputTokens == null || usage.outputTokens == null ? null : usage.inputTokens + usage.outputTokens,
    cost_usd: cost.costUsd, actual_cost_usd: cost.actualCostUsd,
    estimated_cost_usd: cost.estimatedCostUsd, cost_source: cost.source,
    cost_data: JSON.stringify(cost),
  };
  const update: RunUpdate = { status, ...(error === null ? {} : { error }), ...accounting };
  return { row, unmet, status, update };
});
