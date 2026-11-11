/** Plan contributions remain private until the deletion job leaves its plans phase. */
const RETIRING = "FROM session_deletion_jobs j INDEXED BY idx_session_deletion_plan_retirement WHERE j.state='running' AND j.phase='plans'";

/** A visibility fence over the job's existing state, scoped by its Project and optionally its session. */
export function retiringPlansSql(projects: string): string {
  return `EXISTS(SELECT 1 ${RETIRING} AND ${projects} LIMIT 1)`;
}
