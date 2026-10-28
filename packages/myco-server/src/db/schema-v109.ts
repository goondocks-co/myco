/** Single-flight subjects of pulled and subject-bearing runs; live lookups use `idx_agent_runs_task_live`. */
export const V109_STATEMENTS: readonly string[] = [
  'ALTER TABLE agent_runs ADD COLUMN subject TEXT',
];
