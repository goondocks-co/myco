import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

export interface PipelineHealth {
  stages: Record<string, Record<string, number>>;
  circuits: Array<{
    provider_role: string;
    state: string;
    failure_count: number;
    last_error: string | null;
  }>;
  totals: {
    pending: number;
    processing: number;
    failed: number;
    blocked: number;
    poisoned: number;
    succeeded: number;
  };
}

export function usePipeline() {
  return usePowerQuery<PipelineHealth>({
    queryKey: ['pipeline-health'],
    queryFn: ({ signal }) => fetchJson<PipelineHealth>('/pipeline/health', { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
