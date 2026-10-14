import { REPOSITORY_TASKS } from '@goondocks/myco-shared/repository';
import type { RelationalStore } from '../core/adapters.js';
import { admissionForTask } from '../core/task-catalogue.js';
import { capabilityOnSql } from '../core/settings.js';
import { projectsDriving, type ProjectSet } from './scope.js';

/** Maximum repository notices in one dashboard read; overflow marks the check unavailable. */
export const MAX_REPOSITORY_NOTICES = 100;
const CODE_CAPABILITIES = [...new Set(REPOSITORY_TASKS.flatMap(task => {
  const gate = admissionForTask(task);
  return gate?.kind === 'capability' ? [gate.capability] : [];
}))];

/** Live projects with enabled code work and no connected source, in one bounded, credential-blind read. */
export async function repositoriesNeeded(db: RelationalStore, scope: ProjectSet): Promise<Array<{ projectId: string }>> {
  if (CODE_CAPABILITIES.length === 0) return [];
  const projects = projectsDriving(scope, 'p.project_id');
  const requested = CODE_CAPABILITIES.map(() => 'SELECT ? AS capability').join(' UNION ALL ');
  const rows = (await db.prepare(`SELECT p.project_id AS projectId FROM projects p
    WHERE ${projects.sql}
      AND NOT EXISTS (SELECT 1 FROM project_repositories r WHERE r.project_id = p.project_id)
      AND EXISTS (SELECT 1 FROM (${requested}) requested
        WHERE ${capabilityOnSql('p.project_id', 'requested.capability')})
    ORDER BY p.project_id LIMIT ?`).bind(...projects.params, ...CODE_CAPABILITIES, MAX_REPOSITORY_NOTICES + 1).all<{ projectId: string }>()).results;
  if (rows.length > MAX_REPOSITORY_NOTICES) throw new Error('Repository notices exceed the dashboard read limit');
  return rows;
}
