/** Recent task-start counts seek only the admission window. */
export const V696_STATEMENTS: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_task_started ON agent_runs(task,started_at,id)',
];
