import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { useMe } from './use-me';
import { useProjects } from './use-projects';
import type { TaskNamesAnswer, TasksAnswer, TaskStartPreview } from '../features/tasks/wire';

/** Task names for run links, reusing a registry already loaded for this project. */
export function useTaskNames(projectId: string) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['task-names', projectId],
    initialData: () => {
      const registry = queryClient.getQueryData<TasksAnswer>(['tasks', projectId, projectId]);
      return registry === undefined ? undefined : { tasks: registry.tasks.map(({ task, name }) => ({ task, name })) };
    },
    queryFn: ({ signal }) => fetchJson<TaskNamesAnswer>(`/api/tasks/names?${new URLSearchParams({ project: projectId })}`, signal),
  });
}

/** Each task's current description, resolved by the server under its effective settings. */
export function useTaskDescriptions(projectId: string | null) {
  const me = useMe();
  const memberAcrossProjects = projectId === null && me.data?.member?.role === 'member';
  const projects = useProjects({ enabled: memberAcrossProjects });
  const scope = projectId ?? (memberAcrossProjects ? projects.data?.projects[0]?.projectId ?? null : null);
  const query = scope === null ? '' : `?${new URLSearchParams({ project: scope })}`;
  const descriptions = useQuery({
    queryKey: ['tasks', projectId ?? 'all', scope],
    enabled: me.data?.member != null && (!memberAcrossProjects || scope !== null),
    queryFn: ({ signal }) => fetchJson<TasksAnswer>(`/api/tasks${query}`, signal),
  });
  return {
    ...descriptions,
    scopeError: memberAcrossProjects ? projects.error : null,
    scopeEmpty: memberAcrossProjects && projects.data !== undefined && projects.data.projects.length === 0,
    retryScope: projects.refetch,
  };
}

/** What starting `task` by hand in `projectId` would do now, read afresh each time a confirmation opens. */
export function useTaskStartPreview(projectId: string | null, task: string | null) {
  return useQuery({
    queryKey: ['task-start', projectId, task],
    enabled: projectId !== null && task !== null,
    staleTime: 0,
    gcTime: 0,
    queryFn: ({ signal }) => fetchJson<TaskStartPreview>(`/api/tasks/start?${new URLSearchParams({ project: projectId!, task: task! })}`, signal),
  });
}
