import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

export interface StatsResponse {
  daemon: {
    pid: number;
    port: number;
    version: string;
    uptime_seconds: number;
    active_sessions: string[];
  };
  vault: {
    path: string;
    name: string;
    session_count: number;
    batch_count: number;
    spore_count: number;
    plan_count: number;
    artifact_count: number;
    entity_count: number;
    edge_count: number;
  };
  embedding: {
    provider: string;
    model: string;
    queue_depth: number;
    embedded_count: number;
    total_embeddable: number;
  };
  curator: {
    last_run_at: number | null;
    last_run_status: string | null;
    total_runs: number;
  };
  digest: {
    freshest_tier: number | null;
    generated_at: number | null;
    tiers_available: number[];
  };
  unprocessed_batches: number;
}

export function useDaemon() {
  return usePowerQuery<StatsResponse>({
    queryKey: ['daemon-stats'],
    queryFn: ({ signal }) => fetchJson<StatsResponse>('/stats', { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
