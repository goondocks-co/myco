import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePowerQuery } from './use-power-query';
import { fetchJson, postJson, putJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

/* ---------- Types ---------- */

export interface UpgradePackageStatus {
  id: string;
  display_name: string;
  package_name: string;
  installed: boolean;
  installed_version: string | null;
  latest_version: string | null;
  latest_stable: string | null;
  latest_beta: string | null;
  update_available: boolean;
  revert_available?: boolean;
}

export interface UpgradeStatus {
  running_version: string;
  update_available?: boolean;
  revert_available?: boolean;
  latest_version?: string;
  latest_stable?: string;
  latest_beta?: string | null;
  channel?: string;
  channel_scope?: 'machine';
  runtime_scope?: 'machine';
  check_interval_hours?: number;
  last_check?: string;
  error?: string | null;
  /** Set when daemon is auto-restarting for a version sync. */
  restarting?: boolean;
  reason?: string;
  packages?: UpgradePackageStatus[];
}

interface ApplyResponse {
  status: string;
  version: string;
}

/* ---------- Query ---------- */

const UPGRADE_QUERY_KEY = ['upgrade-status'] as const;

export function useUpgradeStatus() {
  return usePowerQuery<UpgradeStatus>({
    queryKey: [...UPGRADE_QUERY_KEY],
    queryFn: ({ signal }) => fetchJson<UpgradeStatus>('/upgrade/status', { signal }),
    refetchInterval: POLL_INTERVALS.UPDATE,
    pollCategory: 'standard',
    contextFree: true,
  });
}

/* ---------- Mutations ---------- */

export function useUpgradeCheck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<UpgradeStatus>('/upgrade/check'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...UPGRADE_QUERY_KEY] });
    },
  });
}

export function useUpgradeApply() {
  return useMutation({
    mutationFn: () => postJson<ApplyResponse>('/upgrade/apply'),
  });
}

export function useUpgradeChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channel: string) => putJson<UpgradeStatus>('/upgrade/channel', { channel }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...UPGRADE_QUERY_KEY] });
    },
  });
}
