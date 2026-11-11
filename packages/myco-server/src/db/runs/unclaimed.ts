/**
 * Due queued work no machine has taken: per Project and task, the queued runs whose oldest has waited since before an
 * instant while it waits only for a machine to take it, in a Project that accepts the task's work now. A run a limit,
 * the budget, a busy fleet or a capability holds is not waiting for a taker. Read from the maintained queue heads in
 * `task_runtime`, one keyed seek per Project.
 */
import type { RelationalStore } from '../../core/adapters.js';
import type { HeldBy } from '@goondocks/myco-shared/run-holds';
import { RETAINED_TASKS } from '../../core/task-catalogue.js';
import { taskAcceptedSql } from './task-acceptance.js';
import { read, readSet } from '../index.js';

/** The hold that means a run waits for a machine to take it, and nothing else. */
const WAITING_FOR_A_TAKER: HeldBy = 'worker';
const ACCEPTED = `CASE t.task ${RETAINED_TASKS.map((task) => `WHEN '${task}' THEN ${taskAcceptedSql('t.project_id', task)}`).join(' ')} ELSE 0 END`;

export interface UnclaimedDue { project_id: string; task: string; runs: number; since: number; run_id: string }
const unclaimed = read<[projects: string, queuedBefore: number, hold: string], UnclaimedDue>({ name: 'runs.unclaimedDue', sql: `SELECT project_id,task,runs,since,run_id FROM (
    SELECT t.project_id,t.task,SUM(t.queued_count) OVER w AS runs,t.oldest_queued_at AS since,t.oldest_run_id AS run_id,
      ROW_NUMBER() OVER (PARTITION BY t.project_id,t.task ORDER BY t.oldest_queued_at,t.oldest_run_id) AS position
    FROM json_each(?1) k CROSS JOIN task_runtime t ON t.project_id=k.value
    WHERE t.queued_count>0 AND t.oldest_queued_at<=?2 AND COALESCE(t.hold_reason,?3)=?3 AND ${ACCEPTED}
    WINDOW w AS (PARTITION BY t.project_id,t.task)) WHERE position=1 ORDER BY since,project_id,task` });

/** For each of `projects`, each task whose due queued work has waited for a machine since before `queuedBefore`, oldest first. */
export async function unclaimedDue(db: RelationalStore, projects: readonly string[], queuedBefore: number): Promise<UnclaimedDue[]> {
  if (projects.length === 0) return [];
  const [rows] = await readSet(db, unclaimed.bind(JSON.stringify(projects), queuedBefore, WAITING_FOR_A_TAKER));
  return rows;
}
