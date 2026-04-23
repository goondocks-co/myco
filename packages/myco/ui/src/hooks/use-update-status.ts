import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePowerQuery } from './use-power-query';
import { fetchJson, postJson, putJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

/* ---------- Types ---------- */

export interface UpdatePackageStatus {
  id: string;
  display_name: string;
  package_name: string;
  installed: boolean;
  installed_version: string | null;
  latest_version: string | null;
  latest_stable: string | null;
  latest_beta: string | null;
  update_available: boolean;
}

export interface UpdateStatus {
  exempt: boolean;
  running_version: string;
  update_available?: boolean;
  latest_version?: string;
  latest_stable?: string;
  latest_beta?: string | null;
  channel?: string;
  channel_scope?: 'project';
  runtime_scope?: 'project' | 'machine';
  check_interval_hours?: number;
  last_check?: string;
  error?: string | null;
  /** Set when daemon is auto-restarting for a version sync. */
  restarting?: boolean;
  reason?: string;
  packages?: UpdatePackageStatus[];
}

interface ApplyResponse {
  status: string;
  version: string;
}

/* ---------- Query ---------- */

const UPDATE_QUERY_KEY = ['update-status'] as const;

export function useUpdateStatus() {
  return usePowerQuery<UpdateStatus>({
    queryKey: [...UPDATE_QUERY_KEY],
    queryFn: ({ signal }) => fetchJson<UpdateStatus>('/update/status', { signal }),
    refetchInterval: POLL_INTERVALS.UPDATE,
    pollCategory: 'standard',
  });
}

/* ---------- Mutations ---------- */

export function useUpdateCheck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<UpdateStatus>('/update/check'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...UPDATE_QUERY_KEY] });
    },
  });
}

export function useUpdateApply() {
  return useMutation({
    mutationFn: () => postJson<ApplyResponse>('/update/apply'),
  });
}

export function useUpdateChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channel: string) => putJson<UpdateStatus>('/update/channel', { channel }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...UPDATE_QUERY_KEY] });
    },
  });
}
