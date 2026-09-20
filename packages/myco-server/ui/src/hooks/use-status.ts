import { useQuery } from '@tanstack/react-query';
import { fetchJson, type StatusResponse, type WorkerStatus } from '../lib/api';

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: ({ signal }) => fetchJson<StatusResponse>('/api/status', signal),
  });
}

/** The worker record, or nothing. A refresh that failed answers nothing: the last answer it gave is not current. */
export function useWorkerFleet(): WorkerStatus | undefined {
  const status = useStatus();
  return status.error === null ? status.data?.workers : undefined;
}
