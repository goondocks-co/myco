import type { ServerEnv } from './adapters.js';
import { getRun, renewRunLease, type RunRow } from './runs.js';
import { WORKER_LEASE_MS } from '../constants.js';

export interface WorkerLeaseOwner { tokenId: string; clock: () => number }
export interface WorkerRunIdentity { projectId: string; runId: string }

/** Lease admission for an operation on the worker's currently dispatched attempt. */
export function withLeasedRun<Input extends WorkerRunIdentity, Result>(
  operation: (env: ServerEnv, worker: WorkerLeaseOwner, input: Input, row: RunRow) => Promise<Result>,
): (env: ServerEnv, worker: WorkerLeaseOwner, input: Input) => Promise<Result | { held: false; reason: string }> {
  return async (env, worker, input) => {
    const scope = { projectId: input.projectId };
    const row = await getRun(env.db, scope, input.runId);
    if (row === null) return { held: false, reason: 'no run of that id' };
    if (row.dispatchedBy === null || row.status !== 'running') return { held: false, reason: 'the run is not running' };
    const dispatchedBy = row.dispatchedBy;
    const renew = () => {
      const now = worker.clock();
      return renewRunLease(env.db, scope, input.runId, worker.tokenId, now + WORKER_LEASE_MS, now, dispatchedBy);
    };
    if (!(await renew())) {
      return { held: false, reason: 'the lease is no longer held' };
    }
    const result = await operation(env, worker, input, row);
    if (!(await renew())) return { held: false, reason: 'the lease is no longer held' };
    return result;
  };
}
