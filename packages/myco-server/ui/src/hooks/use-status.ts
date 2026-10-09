import { useQuery } from '@tanstack/react-query';
import { fetchJson, type StatusResponse, type WorkerStatus } from '../lib/api';

/** `/api/status`. `refetchInterval` keeps it current on a page that shows what is happening now. */
export function useStatus(options: { refetchInterval?: number | false; refetchIntervalInBackground?: boolean } = {}) {
  return useQuery({
    queryKey: ['status'],
    queryFn: ({ signal }) => fetchJson<StatusResponse>('/api/status', signal),
    ...options,
  });
}

/** The worker record, or nothing. A refresh that failed answers nothing: the last answer it gave is not current. */
export function useWorkerFleet(): WorkerStatus | undefined {
  const status = useStatus();
  return status.error === null && status.data?.workers.available === true ? status.data.workers : undefined;
}
