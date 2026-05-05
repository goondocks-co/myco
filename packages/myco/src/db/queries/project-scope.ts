/**
 * Shared helpers for project-scoped query predicates.
 *
 * Project scope is a three-state value: `undefined` means "no scope filter"
 * (legacy broad reads), `null` means "rows that have no project_id"
 * (pre-Grove rows), and a string id means "rows belonging to that project".
 *
 * Centralizing the predicate keeps WHERE-clause assembly consistent across
 * every query module — drift here causes silent cross-project leaks.
 */

export type ProjectScope = string | null | undefined;

/**
 * Append a project_id condition to an in-progress WHERE-clause builder.
 *
 * `qualifier` lets joined queries target a specific table alias
 * (e.g. `s.project_id`); leave empty for unqualified column access.
 */
export function appendProjectCondition(
  conditions: string[],
  params: unknown[],
  projectId: ProjectScope,
  qualifier = '',
): void {
  if (projectId === undefined) return;
  const column = qualifier ? `${qualifier}.project_id` : 'project_id';
  if (projectId === null) {
    conditions.push(`${column} IS NULL`);
  } else {
    conditions.push(`${column} = ?`);
    params.push(projectId);
  }
}

/**
 * Build a standalone `(sql, params)` fragment for a project_id predicate.
 * `sql` is `''` when there is no scope, otherwise a leading `AND` clause
 * suitable for splicing onto an existing WHERE.
 */
export function projectScopeClause(
  projectId: ProjectScope,
  qualifier = '',
): { sql: string; params: unknown[] } {
  if (projectId === undefined) return { sql: '', params: [] };
  const column = qualifier ? `${qualifier}.project_id` : 'project_id';
  if (projectId === null) return { sql: ` AND ${column} IS NULL`, params: [] };
  return { sql: ` AND ${column} = ?`, params: [projectId] };
}
