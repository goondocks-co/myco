import { useQuery } from '@tanstack/react-query';
import { fetchJson, type ProjectsResponse } from '../lib/api';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => fetchJson<ProjectsResponse>('/api/projects', signal),
  });
}
