import { useQuery } from '@tanstack/react-query';
import { fetchJson, type StatusResponse } from '../lib/api';

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: ({ signal }) => fetchJson<StatusResponse>('/api/status', signal),
  });
}
