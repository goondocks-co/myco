import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

/** The Project's repository map as the Deployment stores it: the rendered markdown and the commit it was read from. */
export interface CanopyMapRow {
  revision: string;
  content: string;
  repository: { url: string; branch: string; commit: string };
  sourceRunId: string;
  generatedAt: number;
}

/** The Project's current repository map, or null when no map run has written one. */
export function useCanopyMap(projectId: string) {
  return useQuery({
    queryKey: ['canopy-map', projectId],
    queryFn: ({ signal }) => fetchJson<{ map: CanopyMapRow | null }>(`/api/projects/${encodeURIComponent(projectId)}/canopy-map`, signal),
  });
}
