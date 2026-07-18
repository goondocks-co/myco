// @vitest-environment jsdom

import { describe, it, expect, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock every hook the dashboard composes — minimal happy-path values.

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectSelection: () => ({
    grove: {
      id: 'g1',
      name: 'Test Grove',
      slug: 'test',
      mode: 'local',
      is_default: true,
      created_at: '2026-01-01',
      project_count: 2,
      projects: [],
    },
    project: { id: 'p1', name: 'p', root: '/' },
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: () => ({
    data: {
      context: {
        request: { machine_id: 'mach-1' },
        project: { id: 'p', name: 'p' },
        grove: { id: 'g1' },
      },
      daemon: { pid: 1, port: 19344, version: '0.27.9', uptime_seconds: 12345, active_sessions: [] },
      vault: {
        session_count: 0,
        batch_count: 0,
        spore_count: 0,
        plan_count: 0,
        artifact_count: 0,
        entity_count: 0,
        edge_count: 0,
        name: 'v',
        path: '/',
      },
      embedding: { provider: 'p', model: 'm', queue_depth: 0, embedded_count: 0, total_embeddable: 0 },
      agent: { last_run_at: null, last_run_status: null, total_runs: 0 },
      digest: { freshest_tier: null, generated_at: null, tiers_available: [] },
      canopy: { entries_count: 0, described_count: 0 },
      unprocessed_batches: 0,
    },
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-maintenance-summary', () => ({
  useProjectsActivity: () => ({
    data: { projects: [], active_window_days: 7, generated_at: '2026-05-15' },
    isLoading: false,
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-sessions', () => ({
  useSessions: () => ({ data: { sessions: [] }, isLoading: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-embedding-details', () => ({
  useEmbeddingDetails: () => ({
    data: { total: 0, pending: {}, by_namespace: {}, provider: { name: 'x', model: 'y' } },
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-database-details', () => ({
  useDatabaseDetails: () => ({
    data: {
      file: { size_bytes: 0, fragmentation_pct: 0, wal_size_bytes: 0 },
      indexes: [],
      last_optimize_at: null,
      last_integrity_check: null,
    },
  }),
}));

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: async () => ({ backups: [] }),
  postJson: async () => ({}),
  putJson: async () => ({}),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
  ApiError: class extends Error {},
}));

mock.module('../../packages/myco/ui/src/hooks/use-groves', () => ({
  useGroves: () => ({
    data: {
      groves: [
        {
          id: 'g1',
          name: 'Test Grove',
          slug: 'test',
          mode: 'local',
          is_default: true,
          created_at: '2026-01-01',
          project_count: 2,
          projects: [],
        },
      ],
    },
    isLoading: false,
  }),
}));

import GroveDashboard from '../../packages/myco/ui/src/pages/GroveDashboard';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/g/test']}>
        <GroveDashboard />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('GroveDashboard', () => {
  it('renders identity strip + projects + active-now + vault sections', async () => {
    render(wrap());
    await waitFor(() => {
      expect(screen.getAllByText('Test Grove').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Projects/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Active now/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Vault/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Backup/i).length).toBeGreaterThan(0);
    });
  });
});
