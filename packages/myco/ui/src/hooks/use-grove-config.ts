import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, putJson } from '../lib/api';
import { useProjectSelection } from './use-project-selection';

/**
 * Grove-tier config shape — mirrors `GroveConfigSchema` server-side.
 * The fields here drive the Grove Settings page; everything that flows
 * into a shared SQLite DB or the daemon's machine-wide power loops
 * lives at this tier.
 */
export interface GroveConfig {
  daemon: {
    stale_session_threshold_ms: number;
  };
  backup: {
    dir?: string | null;
    retention: {
      keep_daily: number;
      keep_weekly: number;
    };
  };
  maintenance: {
    auto_optimize: boolean;
    auto_optimize_interval_hours: number;
    auto_integrity_check: boolean;
    auto_integrity_check_interval_hours: number;
  };
  embedding: {
    run_in_deep_sleep: boolean;
  };
  agent: {
    scheduled_tasks_active_window_days: number;
  };
  team: {
    enabled: boolean;
    worker_url?: string;
    team_id?: string;
    interval_minutes?: number;
  };
}

export interface GroveConfigResponse {
  groveId: string;
  config: GroveConfig;
}

const GROVE_CONFIG_KEY = ['grove-config'] as const;

function groveConfigQueryKey(groveId: string | null) {
  return [...GROVE_CONFIG_KEY, groveId ?? 'none'] as const;
}

export function useGroveConfig() {
  const selection = useProjectSelection();
  const groveId = selection?.grove.id ?? null;
  return useQuery({
    queryKey: groveConfigQueryKey(groveId),
    queryFn: ({ signal }) => fetchJson<GroveConfigResponse>('/grove-config', { signal }),
    enabled: groveId !== null,
  });
}

export function useUpdateGroveConfig() {
  const qc = useQueryClient();
  const selection = useProjectSelection();
  const groveId = selection?.grove.id ?? null;

  return useMutation({
    mutationFn: (patch: Partial<GroveConfig>) =>
      putJson<GroveConfig>('/grove-config', { patch }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: groveConfigQueryKey(groveId) });
      // The merged-config view depends on Grove tier values, so bust it.
      void qc.invalidateQueries({ queryKey: ['config', 'merged'] });
    },
  });
}
