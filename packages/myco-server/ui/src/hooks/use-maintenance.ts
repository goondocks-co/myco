import { useQuery } from '@tanstack/react-query';
import type { MaintenanceAnswer } from '../features/admin/health/wire';
import { fetchJson } from '../lib/api';
import { live } from '../lib/live';

/** The store's routine checks and what each last found, read again quickly while one runs so its outcome appears. */
export function useMaintenance({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['maintenance'],
    enabled,
    queryFn: ({ signal }) => fetchJson<MaintenanceAnswer>('/api/maintenance', signal),
    ...live<MaintenanceAnswer>({ whileMoving: (data) => data?.checks.some((c) => c.running) ?? false, quick: true }),
  });
}
