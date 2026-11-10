import { reaching, type Reach, changing } from './schema-step.js';
/** Single-flight subjects of pulled and subject-bearing runs; live lookups use `idx_agent_runs_task_live`. */
export const V109_STATEMENTS: readonly string[] = [
  'ALTER TABLE agent_runs ADD COLUMN subject TEXT',
];

/** Why the step reaches tables earlier steps created. */
export const V109_REACHES: readonly Reach[] = changing(['agent_runs'], 'Runs retain the single-flight subject a pulled or subject-bearing claim writes.');
