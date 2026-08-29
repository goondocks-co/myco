import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson, type ProjectsResponse } from '../lib/api';

/** Every project, archived ones included: one read serves the landing page, the navigation and a project's home, each filtering as it needs. */
export function useProjects(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => fetchJson<ProjectsResponse>('/api/projects?include=archived', signal),
    enabled: options.enabled ?? true,
  });
}

/** Archive and unarchive, each refreshing the lists that show the change. */
export function useProjectActions() {
  const client = useQueryClient();
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['projects'] }), client.invalidateQueries({ queryKey: ['status'] })]);
  return {
    archive: useMutation({ mutationFn: (projectId: string) => postJson<{ archived: true; archivedBy: string }>(`/api/projects/${encodeURIComponent(projectId)}/archive`), onSuccess: refresh }),
    unarchive: useMutation({ mutationFn: (projectId: string) => postJson<{ archived: false }>(`/api/projects/${encodeURIComponent(projectId)}/unarchive`), onSuccess: refresh }),
  };
}
