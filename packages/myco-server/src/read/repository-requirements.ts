import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { allTasksReadRepository } from '@goondocks/myco-shared/repository';
import type { ServerEnv } from '../core/adapters.js';
import { admissionForTask, RETAINED_TASKS } from '../core/task-catalogue.js';
import { capabilityExplicitlyOnSql, capabilityOnSql } from '../core/settings.js';
import { scheduleLeaves, scheduledTasks } from '../core/schedule-rules.js';
import { projectsDriving, type ProjectSet, type ReadScope } from './scope.js';

/** Maximum repository notices in one dashboard read. */
export const MAX_REPOSITORY_NOTICES = 100;
const CAPABILITY_TASKS = RETAINED_TASKS.reduce((groups, task) => {
  const gate = admissionForTask(task);
  if (gate?.kind === 'capability') groups.set(gate.capability, [...(groups.get(gate.capability) ?? []), task]);
  return groups;
}, new Map<string, string[]>());
const CODE_CAPABILITIES = [...CAPABILITY_TASKS].filter(([, tasks]) => allTasksReadRepository(tasks)).map(([capability]) => capability);

const MAP_ONLY = [...CAPABILITY_TASKS.values()].filter(allTasksReadRepository).flat().every(task => task === MAP_TASK);
export interface RepositoryRequirement { projectId: string; codeMap?: boolean }
export interface RepositoryRequirements { projects: RepositoryRequirement[]; overflow: boolean }

/** Explicit code intent or an effectively enabled code schedule, scoped and credential-blind. */
export async function repositoriesNeeded(env: ServerEnv, scope: ProjectSet): Promise<RepositoryRequirements> {
  if (CODE_CAPABILITIES.length === 0) return { projects: [], overflow: false };
  const leaves = await scheduleLeaves(env);
  const scheduledCapabilities = new Set<string>(leaves.enabled ? scheduledTasks(leaves.overrides).flatMap(({ task }) => {
    const gate = admissionForTask(task);
    return gate?.kind === 'capability' ? [gate.capability] : [];
  }) : []);
  const requests = CODE_CAPABILITIES.map(capability => ({ capability, scheduled: scheduledCapabilities.has(capability) }));
  const projects = projectsDriving(scope, 'p.project_id');
  const rows = (await env.db.prepare(`SELECT p.project_id AS projectId FROM projects p
    WHERE ${projects.sql} AND p.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM project_repositories r WHERE r.project_id = p.project_id)
      AND EXISTS (SELECT 1 FROM json_each(?) requested
        WHERE ${capabilityExplicitlyOnSql('p.project_id', "json_extract(requested.value, '$.capability')")}
        OR (json_extract(requested.value, '$.scheduled') = 1
          AND ${capabilityOnSql('p.project_id', "json_extract(requested.value, '$.capability')")}))
    ORDER BY p.project_id LIMIT ?`).bind(...projects.params, JSON.stringify(requests), MAX_REPOSITORY_NOTICES + 1).all<{ projectId: string }>()).results;
  return { projects: rows.slice(0, MAX_REPOSITORY_NOTICES).map(row => MAP_ONLY ? row : { ...row, codeMap: false }), overflow: rows.length > MAX_REPOSITORY_NOTICES };
}

/** One project's notice uses its primary-key scope, independently of the dashboard list's cap. */
export async function projectRepositoryNeeded(env: ServerEnv, scope: ReadScope): Promise<RepositoryRequirement | null> {
  return (await repositoriesNeeded(env, { all: false, projectIds: [scope.projectId] })).projects[0] ?? null;
}
