import { keepPreviousData } from '@tanstack/react-query';
import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

export interface TeamStatusResponse {
  connection_scope: 'grove' | 'legacy-project';
  grove: {
    id: string;
    name: string;
    slug: string;
    mode: string;
  } | null;
  project: {
    id: string;
    name: string;
    root: string;
  };
  enabled: boolean;
  worker_url: string | null;
  has_team_key: boolean;
  team_key: string | null;
  has_api_key: boolean;
  api_key: string | null;
  healthy: boolean;
  health_error?: string;
  pending_sync_count: number;
  local_team_package_version: string | null;
  local_team_package_source: 'installed' | 'dev-linked' | 'path' | null;
  cached_team_package_version: string | null;
  deployed_worker_version: string | null;
  worker_update_available: boolean;
  collective_connected: boolean;
  collective_url: string | null;
  collective_project_id: string | null;
  collective_last_settings_sync: number | null;
  collective_last_heartbeat: number | null;
  collective_capabilities: string[];
  collective_settings: Record<string, unknown>;
  vector_reindex_status: string | null;
  vector_reindex_last_table: string | null;
  vector_reindex_last_error: string | null;
  vector_reindex_last_run_at: number | null;
  vector_reindex_last_processed: number | null;
  vector_reindex_last_reindexed: number | null;
  vector_reindex_last_deleted: number | null;
  machine_id: string;
  package_version: string;
  schema_version: number;
  sync_protocol_version: number;
  mcp_token: string | null;
  mcp_endpoint: string | null;
}

export function useTeamStatus() {
  return usePowerQuery<TeamStatusResponse>({
    queryKey: ['team-status'],
    queryFn: ({ signal }) => fetchJson<TeamStatusResponse>('/team/status', { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}

// ---------------------------------------------------------------------------
// Sync / DLQ surfaces (queue-aware operator UI)
// ---------------------------------------------------------------------------

export interface QueueStats {
  /** null when Cloudflare's queue API verifies the queue but does not expose a live backlog depth. */
  depth: number | null;
  oldest_msg_age_s: number | null;
}

export interface QueueStatsResponse {
  main: QueueStats;
  dlq: QueueStats;
}

export interface DlqMessage {
  msg_id: string;
  body: Record<string, unknown>;
  attempts: number;
  last_failure?: string;
  enqueued_at?: number;
}

export interface DlqListResponse {
  messages: DlqMessage[];
  next_cursor: string | null;
}

export interface TeamRemoteSyncSummary {
  generated_at: number;
  total_records: number;
  tables: Record<string, number>;
  schema_version: number | null;
  package_version: string;
  sync_protocol_version: number;
}

export interface TeamHandoffSummary {
  completed_at: string;
  started_at: string | null;
  duration_ms: number | null;
  enqueued: number | null;
  accepted: number;
  rejected: number;
  batches: number;
  error: string | null;
  mode: string | null;
  source: 'handoff_log' | 'flush_logs';
}

export interface TeamSyncSummaryResponse {
  generated_at: number;
  local: {
    total_records: number;
    pending_sync_count: number;
    tables: Record<string, number>;
    schema_version: number;
  };
  remote: TeamRemoteSyncSummary | null;
  remote_error: string | null;
  last_handoff: TeamHandoffSummary | null;
}

/** Worker discriminator when remote operator credentials are not configured. */
export type CfApiTokenMissing = { error: 'cf_api_token_not_configured' };

export function isTokenMissing(value: unknown): value is CfApiTokenMissing {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { error?: string }).error === 'cf_api_token_not_configured'
  );
}

export function useTeamQueueStats(enabled: boolean) {
  // keepPreviousData prevents the UI from flashing the empty state on refetch.
  return usePowerQuery<QueueStatsResponse | CfApiTokenMissing>({
    queryKey: ['team-queue-stats'],
    queryFn: ({ signal }) => fetchJson<QueueStatsResponse | CfApiTokenMissing>('/team/queue-stats', { signal }),
    refetchInterval: POLL_INTERVALS.UPDATE,
    pollCategory: 'standard',
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useTeamSyncSummary(enabled: boolean) {
  return usePowerQuery<TeamSyncSummaryResponse>({
    queryKey: ['team-sync-summary'],
    queryFn: ({ signal }) => fetchJson<TeamSyncSummaryResponse>('/team/sync-summary', { signal }),
    refetchInterval: POLL_INTERVALS.UPDATE,
    pollCategory: 'standard',
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useTeamDlq(enabled: boolean) {
  return usePowerQuery<DlqListResponse | CfApiTokenMissing>({
    queryKey: ['team-dlq'],
    queryFn: ({ signal }) => fetchJson<DlqListResponse | CfApiTokenMissing>('/team/dlq', { signal }),
    refetchInterval: POLL_INTERVALS.UPDATE,
    pollCategory: 'standard',
    enabled,
    placeholderData: keepPreviousData,
  });
}
