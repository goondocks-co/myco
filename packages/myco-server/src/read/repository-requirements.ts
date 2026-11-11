import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { allTasksRequireRepository } from '@goondocks/myco-shared/repository';
import type { ServerEnv } from '../core/adapters.js';
import { admissionForTask, RETAINED_TASKS } from '../core/task-catalogue.js';
import { projectsNeedingRepository } from '../db/storage/repository-notices.js';
import { scheduleLeaves, scheduledTasks } from '../core/schedule-rules.js';
import type { ProjectSet, ReadScope } from './scope.js';

/** Maximum repository notices in one dashboard read. */
const MAX_REPOSITORY_NOTICES = 100;
const CAPABILITY_TASKS = RETAINED_TASKS.reduce((groups, task) => {
  const gate = admissionForTask(task);
  if (gate?.kind === 'capability') groups.set(gate.capability, [...(groups.get(gate.capability) ?? []), task]);
  return groups;
}, new Map<string, string[]>());
const CODE_CAPABILITIES = [...CAPABILITY_TASKS].filter(([, tasks]) => allTasksRequireRepository(tasks)).map(([capability]) => capability);

const MAP_ONLY = [...CAPABILITY_TASKS.values()].filter(allTasksRequireRepository).flat().every(task => task === MAP_TASK);
interface RepositoryRequirement { projectId: string; codeMap?: boolean }
interface RepositoryRequirements { projects: RepositoryRequirement[]; overflow: boolean }

/** Explicit code intent or an effectively enabled code schedule, scoped and credential-blind. */
export async function repositoriesNeeded(env: ServerEnv, scope: ProjectSet): Promise<RepositoryRequirements> {
  if (CODE_CAPABILITIES.length === 0) return { projects: [], overflow: false };
  const leaves = await scheduleLeaves(env);
  const scheduledCapabilities = new Set<string>(leaves.enabled ? scheduledTasks(leaves.overrides).flatMap(({ task }) => {
    const gate = admissionForTask(task);
    return gate?.kind === 'capability' ? [gate.capability] : [];
  }) : []);
  const requests = CODE_CAPABILITIES.map(capability => ({ capability, scheduled: scheduledCapabilities.has(capability) }));
  const rows = (await projectsNeedingRepository(env.db, { requests, projects: scope.all ? 'all' : scope.projectIds, limit: MAX_REPOSITORY_NOTICES + 1 }))
    .map(projectId => ({ projectId }));
  return { projects: rows.slice(0, MAX_REPOSITORY_NOTICES).map(row => MAP_ONLY ? row : { ...row, codeMap: false }), overflow: rows.length > MAX_REPOSITORY_NOTICES };
}

/** One project's notice uses its primary-key scope, independently of the dashboard list's cap. */
export async function projectRepositoryNeeded(env: ServerEnv, scope: ReadScope): Promise<RepositoryRequirement | null> {
  return (await repositoriesNeeded(env, { all: false, projectIds: [scope.projectId] })).projects[0] ?? null;
}
