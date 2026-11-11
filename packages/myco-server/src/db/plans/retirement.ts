/** Plan contributions remain private until the deletion job leaves its plans phase. */
const RETIRING = "FROM session_deletion_jobs INDEXED BY idx_session_deletion_plan_retirement WHERE state='running' AND phase='plans'";

/** A visibility fence over the job's existing state, for a Project, named Projects or all live Projects. */
export function retiringPlansSql(projects: string): string {
  return `EXISTS(SELECT 1 ${RETIRING} AND ${projects} LIMIT 1)`;
}
