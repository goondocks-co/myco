import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../lib/api';
import type { ForgetAnswer, RecoveryStatus } from '../features/admin/health/wire';

export type { LatestAttempt, RecoveryAvailability, RecoverySchedule, RecoveryStatus } from '../features/admin/health/wire';

/**
 * The Deployment's recovery state, read only. A Deployment that runs no
 * producer answers 400 for this route, which is not a dashboard error: Health
 * says automatic recovery is unavailable here, so the query does not retry it.
 */
export function useRecovery() {
  return useQuery({
    queryKey: ['recovery', 'exports'],
    queryFn: ({ signal }) => fetchJson<RecoveryStatus>('/api/recovery/exports', signal),
    retry: false,
  });
}

/**
 * Forget the export an earlier attempt requested and never saw settle, at the
 * owner's word that it runs no longer: the next attempt then starts its own.
 * The server refuses while an attempt still runs.
 */
export function useForgetUnsettledExport() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<ForgetAnswer>('/api/recovery/exports/forget-unsettled', {}),
    onSuccess: () => { void queries.invalidateQueries({ queryKey: ['recovery'] }); },
  });
}
