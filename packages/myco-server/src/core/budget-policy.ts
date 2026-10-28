import { TASK_TIERS } from './task-catalogue.js';
import { SERVER_STATE_PREFIX } from '../constants.js';

export const BUDGET_ESTIMATE_PREFIX = `${SERVER_STATE_PREFIX}budget.estimate.`;
export const BUDGET_LEAF = 'agent.budget.daily_usd';
export const BUDGET_DEFAULT_USD = 20;
export const BUDGET_MINIMUM_USD = 1;
export const BUDGET_WINDOW_MS = 86_400_000;
export const BUDGET_WORKER_TASKS = Object.keys(TASK_TIERS);
export const UNKNOWN_STAGE_SEED_USD = 1;
const SEEDS: Readonly<Record<string, number>> = { 'title-summary': 0.10, 'canopy-map': 1, 'extract-curate': 0.50, 'turn-cards': 0.05, 'vault-seed': 1 };
export const seedForStage = (task: string): number => SEEDS[task] ?? UNKNOWN_STAGE_SEED_USD;
export const workerTaskSql = (column: string): string => `${column} IN (${BUDGET_WORKER_TASKS.map(task => `'${task.replaceAll("'", "''")}'`).join(',')})`;
export const stageSeedSql = (column: string): string => `CASE ${column} ${Object.entries(SEEDS).map(([task, value]) => `WHEN '${task}' THEN ${value}`).join(' ')} ELSE ${UNKNOWN_STAGE_SEED_USD} END`;
