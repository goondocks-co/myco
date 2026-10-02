import { parseWorkerAccounting, type WorkerUsage, type ExecutionIdentity } from '@goondocks/myco-shared/worker-usage';
import { MAX_RUN_ERROR_CHARS } from '../constants.js';
import { resolveWorkerCost } from './cost/worker.js';
import { runCloseRefusal } from './run-postconditions.js';
import { getRequestedWorkerProfile, type RunUpdate } from './runs.js';
import { withLeasedRun, type WorkerRunIdentity } from './worker-run.js';
import { profileModelMatches, MODEL_MISMATCH, type ProfileRefusal } from '@goondocks/myco-shared/execution-profile';
import { FAILURE_REASON_KEY } from '../db/run-context.js';
import type { RunErrorCode } from './reader-codes.js';

interface WorkerEnd extends WorkerRunIdentity {
  status: 'completed' | 'failed';
  error?: string | null;
  usage?: WorkerUsage | null;
  identity?: ExecutionIdentity;
  accountingVersion?: number;
  /** Set where the worker ended the run on its agent's refusal of the claimed profile. */
  refusal?: ProfileRefusal | null;
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
  const { usage = null, attemptId, accountingVersion, identity: reportedIdentity } = parseWorkerAccounting(run);
  const requested = await getRequestedWorkerProfile(env.db, { projectId: run.projectId }, run.runId, row.dispatchedBy);
  const mismatch = requested !== null && reportedIdentity !== undefined && reportedIdentity.status !== 'unknown'
    && !profileModelMatches(row.harness ?? '', requested.model, reportedIdentity.primary);
  const identity = mismatch && reportedIdentity !== undefined
    ? { ...reportedIdentity, warnings: [...new Set([...(reportedIdentity.warnings ?? []), MODEL_MISMATCH])] } : reportedIdentity;
  const unmet = run.status === 'completed' ? await runCloseRefusal(env.db, { projectId: run.projectId }, row) : null;
  const status = unmet === null ? run.status : 'failed';
  const error = runError(status, unmet, run.error ?? null);
  const cost = await resolveWorkerCost(row.harness ?? '', usage, identity);
  const primary = identity === undefined || identity.status === 'unknown' ? null : identity.primary;
  const accounting: RunUpdate = attemptId === undefined ? {} : {
    ...(identity === undefined ? (usage?.model === undefined ? {} : { model: usage.model }) : { model: primary?.model ?? null }),
    ...(identity === undefined ? (usage?.provider === undefined ? {} : { provider: usage.provider }) : { provider: primary?.provider ?? null }),
    usage_data: identity === undefined ? (usage === null ? null : JSON.stringify(usage)) : JSON.stringify({ ...usage, accountingVersion, identity }),
    tokens_used: usage?.tokenScope !== undefined || usage?.inputTokens == null || usage.outputTokens == null ? null : usage.inputTokens + usage.outputTokens,
    cost_usd: cost.costUsd, actual_cost_usd: cost.actualCostUsd,
    estimated_cost_usd: cost.estimatedCostUsd, cost_source: cost.source,
    cost_data: JSON.stringify(cost),
  };
  const update: RunUpdate = { status, ...(error === null ? {} : { error }), ...accounting };
  // A worker's profile refusal is a failure the Deployment did not overrule: its code, and its reason for the run's page.
  const refused = run.refusal != null && run.status === 'failed' && unmet === null;
  const errorCode: RunErrorCode = refused ? 'model_not_applied' : 'run_failed';
  const context = refused && run.refusal!.reason !== null ? { [FAILURE_REASON_KEY]: run.refusal!.reason } : undefined;
  return { row, unmet, status, update, errorCode, context };
});
