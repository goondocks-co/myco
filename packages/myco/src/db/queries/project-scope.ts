/**
 * Shared helpers for project-scoped query predicates.
 *
 * Every read-side query that filters on `project_id` must take a
 * `ProjectScope` (the strict union from `@myco/grove/ids.js`). The three
 * kinds — `'project'`, `'global'`, `'all'` — force callers to make the
 * choice explicit at the type level. No more `projectId?: string | null`
 * defaulting silently to `WHERE project_id IS NULL` or "no filter".
 */

import type { ProjectScope } from '@myco/grove/ids.js';

export type { ProjectScope };

/**
 * Append a project_id condition to an in-progress WHERE-clause builder.
 *
 * `qualifier` lets joined queries target a specific table alias
 * (e.g. `s.project_id`); leave empty for unqualified column access.
 */
export function appendProjectCondition(
  conditions: string[],
  params: unknown[],
  scope: ProjectScope,
  qualifier = '',
): void {
  if (scope.kind === 'all') return;
  const column = qualifier ? `${qualifier}.project_id` : 'project_id';
  if (scope.kind === 'global') {
    conditions.push(`${column} IS NULL`);
  } else {
    conditions.push(`${column} = ?`);
    params.push(scope.id);
  }
}

/**
 * Build a standalone `(sql, params)` fragment for a project_id predicate.
 * `sql` is `''` when the scope is `'all'`, otherwise a leading `AND`
 * clause suitable for splicing onto an existing WHERE.
 */
export function projectScopeClause(
  scope: ProjectScope,
  qualifier = '',
): { sql: string; params: unknown[] } {
  if (scope.kind === 'all') return { sql: '', params: [] };
  const column = qualifier ? `${qualifier}.project_id` : 'project_id';
  if (scope.kind === 'global') return { sql: ` AND ${column} IS NULL`, params: [] };
  return { sql: ` AND ${column} = ?`, params: [scope.id] };
}
