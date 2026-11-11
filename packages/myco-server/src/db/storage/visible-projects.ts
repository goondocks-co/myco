/** A predicate over `alias.project_id` that holds for Projects accepting capture: one primary-key check per row. */
export const visibleProjectSql = (alias: string): string =>
  `EXISTS (SELECT 1 FROM projects p WHERE p.project_id = ${alias}.project_id AND p.archived_at IS NULL)`;
