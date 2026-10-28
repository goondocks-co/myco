import type { RelationalStore } from './adapters.js';
import type { ClaimCandidate } from './runs.js';
import { BUDGET_WORKER_TASKS } from './budget-policy.js';

/** The oldest unclaimed queued row of one task and origin, through the queue-head index; `task` and `origin` are SQL expressions. */
export const queueHeadSeek = (columns: string, task: string, origin: string): string => `SELECT ${columns}
        FROM agent_runs INDEXED BY idx_agent_runs_queue_head WHERE status='queued' AND dispatched_by IS NULL AND task=${task} AND origin=${origin}
        ORDER BY queued_at,id LIMIT 1`;

/** Two queue-head seeks per compatible task, independent of the queue prefix. */
export async function queueHeads(db: RelationalStore, excluded: readonly string[]): Promise<ClaimCandidate[]> {
  const heads: (ClaimCandidate & {queuedAt:number})[]=[];
  for (const task of BUDGET_WORKER_TASKS.filter(task=>!excluded.includes(task))) {
    for (const origin of ['manual','automatic']) {
      const row = await db.prepare(queueHeadSeek('project_id AS projectId,id,task,instruction,dispatch_spec AS dispatchSpec,queued_at AS queuedAt', '?', '?'))
        .bind(task,origin)
        .first<ClaimCandidate & {queuedAt:number}>();
      if (row!==null) heads.push(row);
    }
  }
  return heads.sort((a,b)=>a.queuedAt-b.queuedAt || a.id.localeCompare(b.id));
}
