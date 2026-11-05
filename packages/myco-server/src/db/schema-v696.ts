/** Admission counts seek live statuses and recent task starts; holder changes seek only matching unclaimed rows. */
export const CLAIM_READ_STEPS = [
  ['CREATE INDEX IF NOT EXISTS idx_agent_runs_status_id ON agent_runs(status,id)'],
  ['CREATE INDEX IF NOT EXISTS idx_agent_runs_task_started ON agent_runs(task,started_at,id)'],
  ["CREATE INDEX IF NOT EXISTS idx_agent_runs_queue_holder ON agent_runs(task,held_by) WHERE status='queued' AND dispatched_by IS NULL"],
].map((statements, index) => ({ version: 696 + index, statements }));
