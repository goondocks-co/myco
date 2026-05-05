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
  has_api_key: boolean;
  api_key: string | null;
  healthy: boolean;
  health_error?: string;
  pending_sync_count: number;
  local_team_package_version: string | null;
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
  local_only_disclosures: LocalOnlyDisclosure[];
}

/** Server-canonical "what stays local" disclosure surfaced on the Team page. */
export interface LocalOnlyDisclosure {
  table: string;
  columns: string[];
  rationale: string;
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
// Outbox / DLQ surfaces (queue-aware operator UI)
// ---------------------------------------------------------------------------

export interface QueueStats {
  /** null until CF Queues GraphQL Analytics is wired; UI renders "—". */
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

/** Worker discriminator for the "no CF API token configured" response. */
export type CfApiTokenMissing = { error: 'cf_api_token_not_configured' };

export function isTokenMissing(value: unknown): value is CfApiTokenMissing {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { error?: string }).error === 'cf_api_token_not_configured'
  );
}

export function useTeamQueueStats(enabled: boolean) {
  // Polled slowly because the live values (depth, oldest_msg_age_s) are
  // stubbed until the GraphQL Analytics wiring lands; the data effectively
  // doesn't change. keepPreviousData prevents the UI from flashing the
  // empty state on refetch.
  return usePowerQuery<QueueStatsResponse | CfApiTokenMissing>({
    queryKey: ['team-queue-stats'],
    queryFn: ({ signal }) => fetchJson<QueueStatsResponse | CfApiTokenMissing>('/team/queue-stats', { signal }),
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
