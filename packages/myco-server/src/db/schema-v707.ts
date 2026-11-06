/** Machine pages seek each worker credential's latest run. */
export const V707_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_agent_runs_worker_started ON agent_runs(leased_by,started_at DESC)",
];
