import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { RUN_ADMISSION_READY_SQL } from './live.js';

const liveness = read<[number], { workersBusy: number; runsQueued: number; ready: number }>({
  name: 'runs.workerLiveness', sql: `SELECT ${RUN_ADMISSION_READY_SQL} AS ready,
    (SELECT COUNT(DISTINCT CASE WHEN r.leased_runner_id IS NOT NULL THEN 'runner:' || r.leased_runner_id ELSE 'member:' || r.leased_by END)
      FROM agent_runs r INDEXED BY idx_agent_runs_claimable JOIN run_live l ON l.project_id=r.project_id AND l.run_id=r.id
      WHERE r.status='running' AND r.lease_expires_at>?1 AND (r.leased_by IS NOT NULL OR r.leased_runner_id IS NOT NULL)) AS workersBusy,
    COALESCE((SELECT queued FROM admission_contribution WHERE scope='fleet' AND scope_key=''),0) AS runsQueued`,
});
export type WorkerLiveness = { state?: 'ready'; workersBusy: number; runsQueued: number }
  | { state: 'building'; workersBusy: null; runsQueued: null };

/** Busy identities come from current leases; the queued total comes from the fleet contribution. */
export async function workerLiveness(db: RelationalStore, now: number): Promise<WorkerLiveness> {
  const [[row]] = await readSet(db, liveness.bind(now));
  if (row === undefined) throw new Error('Worker liveness is unavailable');
  if (row.ready !== 1) return { state: 'building', workersBusy: null, runsQueued: null };
  return { workersBusy: row.workersBusy, runsQueued: row.runsQueued };
}
