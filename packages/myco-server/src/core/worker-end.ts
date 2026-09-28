import { parseWorkerAccounting, type WorkerUsage } from '@goondocks/myco-shared/worker-usage';
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

/**
 * What a run's record says went wrong, or null where nothing did.
 *
 * A worker reporting a completed run may add what it saw along the way, such
 * as calls that failed or were refused before the harness ended its turn. That
 * is kept only where the run then fails to close, beside why it failed, so a
 * run that ended without its artifact says what cut it short. A run that
 * closed keeps no error.
 */
function runError(status: 'completed' | 'failed', unmet: string | null, reported: string | null): string | null {
  const error = unmet === null
    ? (status === 'failed' ? reported : null)
    : (reported === null ? unmet : `${unmet}: ${reported}`);
  return error === null ? null : error.slice(0, MAX_RUN_ERROR_CHARS);
}

/** Close evidence and accounting are prepared under the same dispatched attempt. */
export const prepareWorkerEnd = withLeasedRun(async (env, _worker, run: WorkerEnd, row) => {
  const { usage = null, attemptId } = parseWorkerAccounting(run);
  const unmet = run.status === 'completed' ? await runCloseRefusal(env.db, { projectId: run.projectId }, row) : null;
  const status = unmet === null ? run.status : 'failed';
  const error = runError(status, unmet, run.error ?? null);
  const cost = await resolveCost({
    harness: '', model: '',
    usage: usage === null ? {} : Object.fromEntries(Object.entries(usage).filter(([key, value]) =>
      typeof value === 'number' && (usage.tokenScope === undefined || key === 'costUsd' || key === 'estimatedCostUsd'))),
  });
  const accounting: RunUpdate = attemptId === undefined ? {} : {
    ...(usage?.model === undefined ? {} : { model: usage.model }),
    ...(usage?.provider === undefined ? {} : { provider: usage.provider }),
    usage_data: usage === null ? null : JSON.stringify(usage),
    tokens_used: usage?.tokenScope !== undefined || usage?.inputTokens == null || usage.outputTokens == null ? null : usage.inputTokens + usage.outputTokens,
    cost_usd: cost.costUsd, actual_cost_usd: cost.actualCostUsd,
    estimated_cost_usd: cost.estimatedCostUsd, cost_source: cost.source,
    cost_data: JSON.stringify(cost),
  };
  const update: RunUpdate = { status, ...(error === null ? {} : { error }), ...accounting };
  return { row, unmet, status, update };
});
