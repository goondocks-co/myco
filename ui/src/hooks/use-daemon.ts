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
    config_hash: string;
  };
  vault: {
    path: string;
    name: string;
    spore_counts: Record<string, number>;
    session_count: number;
    plan_count: number;
  };
  index: {
    fts_entries: number;
    vector_count: number;
  };
  digest: {
    enabled: boolean;
    consolidation_enabled: boolean;
    metabolism_state: string | null;
    last_cycle: {
      timestamp: string;
      tier: number;
      substrate_count: number;
    } | null;
    substrate_queue: number;
  } | null;
  intelligence: {
    processor: { provider: string; model: string } | null;
    digest: { provider: string; model: string } | null;
    embedding: { provider: string; model: string } | null;
  };
}

export function useDaemon() {
  return usePowerQuery<StatsResponse>({
    queryKey: ['daemon-stats'],
    queryFn: ({ signal }) => fetchJson<StatsResponse>('/stats', { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
