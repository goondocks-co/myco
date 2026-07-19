import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';
import { isAttachedTenancyPending, resolveAttachedEmpty } from '../lib/degrade';
import { useProjectSelection } from './use-project-selection';
import type { ProjectSelection } from '../lib/selection';

export interface StatsResponse {
  context: {
    project: {
      id: string;
      name: string;
      root: string;
      manifest_state: 'present' | 'missing' | 'invalid';
    };
    grove: {
      id: string | null;
      name: string | null;
      slug: string | null;
      mode: 'local' | null;
      binding_id: string | null;
      connection_state: 'local-only' | 'pending' | 'legacy';
    };
    request: {
      source: string;
      project_id: string;
      grove_id: string | null;
      machine_id: string;
      session_id: string | null;
    };
  };
  daemon: {
    pid: number;
    port: number;
    version: string;
    version_label?: string;
    uptime_seconds: number;
    active_sessions: string[];
    runtime?: { source: 'stable' | 'beta' | 'manual'; command: string | null };
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
  agent: {
    last_run_at: number | null;
    last_run_status: string | null;
    total_runs: number;
  };
  digest: {
    freshest_tier: number | null;
    generated_at: number | null;
    tiers_available: number[];
  };
  canopy: {
    entries_count: number;
    described_count: number;
  };
  unprocessed_batches: number;
}

/**
 * The zero-stats object an attached project shows before its first forwarded
 * capture registers it host-side — the BEHAVE-LIKE-LOCAL twin of the fully-
 * zeroed `StatsResponse` a brand-new local project's `/api/stats` returns. Every
 * count is 0; the project/grove identity is carried from the (attached)
 * selection so the Dashboard header/scope cards name the project exactly as they
 * would once data exists. This is the existing `StatsResponse` shape with zeros,
 * not a new shape.
 */
export function emptyStatsForSelection(selection: ProjectSelection): StatsResponse {
  return {
    context: {
      project: {
        id: selection.project.project_id,
        name: selection.project.name,
        root: selection.project.root ?? '',
        manifest_state: 'present',
      },
      grove: {
        id: selection.grove.id,
        name: selection.grove.name,
        slug: selection.grove.slug,
        mode: selection.grove.mode,
        binding_id: selection.project.binding_id,
        connection_state: 'local-only',
      },
      request: {
        source: 'http',
        project_id: selection.project.project_id,
        grove_id: selection.grove.id,
        machine_id: '',
        session_id: null,
      },
    },
    daemon: {
      pid: 0,
      port: 0,
      version: '',
      uptime_seconds: 0,
      active_sessions: [],
    },
    vault: {
      path: '',
      name: selection.project.name,
      session_count: 0,
      batch_count: 0,
      spore_count: 0,
      plan_count: 0,
      artifact_count: 0,
      entity_count: 0,
      edge_count: 0,
    },
    embedding: {
      provider: '',
      model: '',
      queue_depth: 0,
      embedded_count: 0,
      total_embeddable: 0,
    },
    agent: { last_run_at: null, last_run_status: null, total_runs: 0 },
    digest: { freshest_tier: null, generated_at: null, tiers_available: [] },
    canopy: { entries_count: 0, described_count: 0 },
    unprocessed_batches: 0,
  };
}

export function useDaemon() {
  const selection = useProjectSelection();
  return resolveAttachedEmpty(
    usePowerQuery<StatsResponse>({
      queryKey: ['daemon-stats'],
      queryFn: ({ signal }) => fetchJson<StatsResponse>('/stats', { signal }),
      refetchInterval: (query) =>
        isAttachedTenancyPending(query.state.error, selection) ? false : POLL_INTERVALS.STATS,
      retry: (failureCount, err) =>
        isAttachedTenancyPending(err, selection) ? false : failureCount < 3,
      pollCategory: 'standard',
    }),
    selection,
    emptyStatsForSelection,
  );
}
