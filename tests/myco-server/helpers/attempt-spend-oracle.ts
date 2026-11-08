import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { BUDGET_WINDOW_MS, stageSeedSql, workerTaskSql } from '@myco-server-worker/core/budget-policy.js';
import { runOriginSql } from '@myco-server-worker/db/run-context.js';
import { LIVE_RUN_STATUSES } from '@myco-server-worker/db/run-statuses.js';

interface AttemptSpend {
  value: number; estimate: number; costSource: string | null; profileJson: string | null;
  projectId: string; task: string; origin: 'manual' | 'automatic'; attemptId: string; live: number;
}

/** Independent source-history oracle for accounting and portable-restore tests. */
export async function readAttemptSpendOracle(db: RelationalStore, now: number): Promise<AttemptSpend[]> {
  const live = `r.${LIVE_RUN_STATUSES} AND r.dispatched_by IS a.attempt_id`;
  const settled = "r.status IN ('completed','failed','skipped') AND a.attempt_id=r.dispatched_by";
  const seed = stageSeedSql('r.task');
  return (await db.prepare(`SELECT
    COALESCE(a.cost_usd,a.estimate_usd,CASE WHEN ${settled} THEN r.cost_usd END,${seed}) AS value,
    COALESCE(a.estimate_usd,${seed}) AS estimate,
    CASE WHEN a.cost_usd IS NOT NULL THEN COALESCE(a.cost_source,'actual')
      WHEN a.estimate_usd IS NULL AND ${settled} AND r.cost_usd IS NOT NULL THEN COALESCE(r.cost_source,'actual')
      ELSE a.cost_source END AS costSource,
    a.profile_json AS profileJson,a.project_id AS projectId,r.task,${runOriginSql('r')} AS origin,a.attempt_id AS attemptId,
    CASE WHEN ${live} THEN 1 ELSE 0 END AS live
    FROM agent_run_attempts a JOIN agent_runs r ON r.project_id=a.project_id AND r.id=a.run_id
    WHERE ${workerTaskSql('r.task')} AND (a.claimed_at>?1 OR (${live}))
    ORDER BY live,a.claimed_at,a.project_id,a.run_id,a.attempt_id`).bind(now-BUDGET_WINDOW_MS).all<AttemptSpend>()).results;
}
