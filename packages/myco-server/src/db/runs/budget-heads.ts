import { read } from '../index.js';
import { contextValue, BUDGET_QUOTE_USD_KEY, BUDGET_QUOTE_AT_KEY } from '../run-context.js';

const heads = read<[], { projectId: string; runId: string; task: string; requiredUsd: unknown; quotedAt: unknown }>({
  name: 'runs.taskBudgetHeads', sql: `SELECT h.project_id AS projectId,h.oldest_run_id AS runId,h.task,
    ${contextValue(BUDGET_QUOTE_USD_KEY)} AS requiredUsd,${contextValue(BUDGET_QUOTE_AT_KEY)} AS quotedAt
    FROM task_runtime h INDEXED BY idx_task_runtime_budget JOIN agent_runs r ON r.project_id=h.project_id AND r.id=h.oldest_run_id
    WHERE h.queued_count>0 AND h.origin='automatic' AND h.hold_reason='budget'`,
});

/** Only automatic heads can wait on budget; capacity-held and manual work are outside this read. */
export const taskBudgetHeads = () => heads.bind();
