import type { ServerEnv } from './adapters.js';
import { getRun, renewRunLease, workerRunLeaseExpiry, type RunRow } from './runs.js';
import { WORKER_LEASE_MS } from '../constants.js';

export interface WorkerLeaseOwner { tokenId: string; clock: () => number }
export interface WorkerRunIdentity { projectId: string; runId: string; attemptId?: string }

/** Lease admission for an operation on the worker's currently dispatched attempt. */
function leasedRun<Input extends WorkerRunIdentity, Result>(
  operation: (env: ServerEnv, worker: WorkerLeaseOwner, input: Input, row: RunRow & { dispatchedBy: string }) => Promise<Result>,
  finish: 'verify' | 'renew' | 'committed',
): (env: ServerEnv, worker: WorkerLeaseOwner, input: Input) => Promise<Result | { held: false; reason: string }> {
  return async (env, worker, input) => {
    const scope = { projectId: input.projectId };
    const row = await getRun(env.db, scope, input.runId);
    if (row === null) return { held: false, reason: 'no run of that id' };
    if (row.dispatchedBy === null || row.status !== 'running') return { held: false, reason: 'the run is not running' };
    const dispatchedBy = row.dispatchedBy;
    if (input.attemptId !== undefined && input.attemptId !== dispatchedBy) return { held: false, reason: 'the lease is no longer held' };
    const verify = () => {
      const now = worker.clock();
      return workerRunLeaseExpiry(env.db, scope, input.runId, worker.tokenId, now, dispatchedBy);
    };
    if ((await verify()) === null) {
      return { held: false, reason: 'the lease is no longer held' };
    }
    const result = await operation(env, worker, input, { ...row, dispatchedBy });
    if (finish === 'committed') return result;
    if (finish === 'renew') {
      const now = worker.clock();
      if (!(await renewRunLease(env.db, scope, input.runId, worker.tokenId, now + WORKER_LEASE_MS, now, dispatchedBy)))
        return { held: false, reason: 'the lease is no longer held' };
    } else if ((await verify()) === null) return { held: false, reason: 'the lease is no longer held' };
    return result;
  };
}

/** Preparation that hands out no credential and writes no state. */
export function withLeasedRun<Input extends WorkerRunIdentity, Result>(
  operation: (env: ServerEnv, worker: WorkerLeaseOwner, input: Input, row: RunRow & { dispatchedBy: string }) => Promise<Result>,
) { return leasedRun(operation, 'verify'); }

/** Preparation that hands out a repository credential after a final live lease renewal. */
export function withLeasedRunSecret<Input extends WorkerRunIdentity, Result>(
  operation: (env: ServerEnv, worker: WorkerLeaseOwner, input: Input, row: RunRow & { dispatchedBy: string }) => Promise<Result>,
) { return leasedRun(operation, 'renew'); }

/** A commit operation guards its own write and has no later mutation. */
export function withLeasedRunCommit<Input extends WorkerRunIdentity, Result>(
  operation: (env: ServerEnv, worker: WorkerLeaseOwner, input: Input, row: RunRow & { dispatchedBy: string }) => Promise<Result>,
) { return leasedRun(operation, 'committed'); }
