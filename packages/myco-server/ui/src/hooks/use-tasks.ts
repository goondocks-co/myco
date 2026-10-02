import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { useMe } from './use-me';
import { useProjects } from './use-projects';
import type { TasksAnswer } from '../features/tasks/wire';

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
