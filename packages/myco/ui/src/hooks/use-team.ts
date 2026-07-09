import { keepPreviousData, useMutation, useQueryClient } from '@tanstack/react-query';
import { usePowerQuery } from './use-power-query';
import { fetchJson, postJson } from '../lib/api';
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
  team_id: string | null;
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
  mcp_healthy: boolean;
  version_status: 'ok' | 'client_too_old' | 'worker_too_old' | 'unknown';
  daemon_protocol_version: number;
  worker_protocol_version: number | null;
  worker_min_client_version: number | null;
  /** Tables reconcile is skipping because the deployed worker predates them. */
  reconcile_gated_tables: string[];
}

export function teamSuffix(teamId?: string): string {
  return teamId ? `?team_id=${encodeURIComponent(teamId)}` : '';
}

export function useTeamStatus(teamId?: string) {
  const suffix = teamSuffix(teamId);
  return usePowerQuery<TeamStatusResponse>({
    queryKey: ['team-status', teamId ?? null],
    queryFn: ({ signal }) => fetchJson<TeamStatusResponse>(`/team/status${suffix}`, { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}

// ---------------------------------------------------------------------------
// Sync / DLQ surfaces (queue-aware operator UI)
// ---------------------------------------------------------------------------

export interface QueueStatsResponse {
  enqueued: number;
  processed: number;
  failed: number;
  backlog: number;
  last_run_at: number | null;
  last_error: string | null;
  embed_ok?: number;
  embed_failed?: number;
  last_embed_error?: string | null;
  last_embed_at?: number | null;
}

export interface DlqMessage {
  lease_id: string;
  table_name: string;
  row_id: string;
  machine_id: string;
  operation: string;
  reason: string | null;
  created_at: number;
}

export interface DlqListResponse {
  messages: DlqMessage[];
}

export interface TeamRemoteSyncSummary {
  generated_at: number;
  total_records: number;
  tables: Record<string, number>;
  embeddable_count: number | null;
  vector_count: number | null;
  vector_index_healthy: boolean;
  vector_index_error: string | null;
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

export interface TeamDriftRow {
  table: string;
  local: number;
  cloud: number;
  delta: number;
}

export interface TeamSyncSummaryResponse {
  generated_at: number;
  home_serves_team: boolean;
  local: {
    total_records: number;
    pending_sync_count: number;
    tables: Record<string, number>;
    schema_version: number;
  };
  remote: TeamRemoteSyncSummary | null;
  /** This-machine cloud row total (sum of the worker's machine-scoped counts).
   * Null when the worker is too old to scope. Prefer this over the all-machine
   * `remote.total_records` for the summary Delta so cloud orphans under other
   * machine_ids don't read as drift. */
  remote_machine_total: number | null;
  remote_error: string | null;
  last_handoff: TeamHandoffSummary | null;
  drift: TeamDriftRow[];
  total_delta: number;
}

export function useTeamQueueStats(enabled: boolean, teamId?: string) {
  // keepPreviousData prevents the UI from flashing the empty state on refetch.
  const suffix = teamSuffix(teamId);
  return usePowerQuery<QueueStatsResponse>({
    queryKey: ['team-queue-stats', teamId ?? null],
    queryFn: ({ signal }) => fetchJson<QueueStatsResponse>(`/team/queue-stats${suffix}`, { signal }),
    refetchInterval: POLL_INTERVALS.TEAM,
    pollCategory: 'standard',
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useTeamSyncSummary(enabled: boolean, teamId?: string) {
  const suffix = teamSuffix(teamId);
  return usePowerQuery<TeamSyncSummaryResponse>({
    queryKey: ['team-sync-summary', teamId ?? null],
    queryFn: ({ signal }) => fetchJson<TeamSyncSummaryResponse>(`/team/sync-summary${suffix}`, { signal }),
    refetchInterval: POLL_INTERVALS.TEAM,
    pollCategory: 'standard',
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useTeamDlq(enabled: boolean, teamId?: string) {
  const suffix = teamSuffix(teamId);
  return usePowerQuery<DlqListResponse>({
    queryKey: ['team-dlq', teamId ?? null],
    queryFn: ({ signal }) => fetchJson<DlqListResponse>(`/team/dlq${suffix}`, { signal }),
    refetchInterval: POLL_INTERVALS.TEAM,
    pollCategory: 'standard',
    enabled,
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Team registry + project-membership selection
// ---------------------------------------------------------------------------

export interface TeamRegistryRecord {
  team_id: string;
  name: string;
  worker_url: string;
  domain: string | null;
  mcp_endpoint: string | null;
  created_at: string;
  projects: { grove_id: string; project_id: string }[];
  has_deployment?: boolean;
}

export interface TeamProjectRow {
  grove_id: string;
  grove_name: string;
  project_id: string;
  project_name: string;
  team_id: string | null;
}

export interface TeamRegistryResponse {
  teams: TeamRegistryRecord[];
}

export interface TeamProjectsResponse {
  projects: TeamProjectRow[];
}

export interface SetProjectMembershipBody {
  team_id: string;
  grove_id: string;
  project_id: string;
  action: 'add' | 'remove';
}

export interface SetProjectMembershipResponse {
  team: TeamRegistryRecord;
}

export function useTeamRegistry() {
  return usePowerQuery<TeamRegistryResponse>({
    queryKey: ['team-registry'],
    queryFn: ({ signal }) => fetchJson<TeamRegistryResponse>('/team/registry', { signal }),
    refetchInterval: POLL_INTERVALS.TEAM,
    pollCategory: 'standard',
  });
}

export function useTeamProjects() {
  return usePowerQuery<TeamProjectsResponse>({
    queryKey: ['team-projects'],
    queryFn: ({ signal }) => fetchJson<TeamProjectsResponse>('/team/projects', { signal }),
    refetchInterval: POLL_INTERVALS.TEAM,
    pollCategory: 'standard',
  });
}

export function useSetProjectMembership() {
  const qc = useQueryClient();
  return useMutation<SetProjectMembershipResponse, Error, SetProjectMembershipBody>({
    mutationFn: (body) =>
      postJson<SetProjectMembershipResponse>('/team/project-membership', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-registry'] });
      qc.invalidateQueries({ queryKey: ['team-projects'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Team join
// ---------------------------------------------------------------------------

export interface JoinTeamBody {
  worker_url: string;
  team_key: string;
}

export interface JoinTeamResponse {
  team: TeamRegistryRecord;
}

export function useJoinTeam() {
  const qc = useQueryClient();
  return useMutation<JoinTeamResponse, Error, JoinTeamBody>({
    mutationFn: (body) => postJson<JoinTeamResponse>('/team/join', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-registry'] });
      qc.invalidateQueries({ queryKey: ['team-projects'] });
      qc.invalidateQueries({ queryKey: ['team-status'] });
    },
  });
}

export function useForgetTeam() {
  const qc = useQueryClient();
  return useMutation<{ forgotten: boolean }, Error, { team_id: string }>({
    mutationFn: (body) => postJson<{ forgotten: boolean }>('/team/forget', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-registry'] });
      qc.invalidateQueries({ queryKey: ['team-projects'] });
      qc.invalidateQueries({ queryKey: ['team-status'] });
    },
  });
}
