// @vitest-environment jsdom

/**
 * T4 (E-4 W2) acceptance #1 — the Dashboard for an ATTACHED project whose host
 * 404s every knowledge read with `unknown_tenancy` (pre-first-capture) renders
 * the SAME zero-state a brand-new LOCAL project with zero sessions shows, NOT
 * "Failed to connect to daemon".
 *
 * Both fixtures are rendered through the REAL data hooks (only `fetch`,
 * power-state, and selection are stubbed) and asserted against the same
 * load-bearing zero-state elements — the attached case driven by an
 * `unknown_tenancy` 404, the local case by an ordinary zeroed 200.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  GroveProjectSummary,
  GroveSummary,
  ProjectSelection,
} from '../../packages/myco/ui/src/lib/selection';

const EPOCH = new Date(0).toISOString();

const attachedProject: GroveProjectSummary = {
  project_id: 'proj_attached_0000000000000000000000',
  name: 'Shared Service',
  slug: 'shared-service-abcdef',
  root: null,
  binding_id: null,
  status: 'active',
  archived_at: null,
  created_at: EPOCH,
  updated_at: EPOCH,
  manifest_state: 'present',
  attached: true,
  host_id: 'host_mac_studio',
  host_label: 'Mac Studio',
};

const localProject: GroveProjectSummary = {
  ...attachedProject,
  project_id: 'proj_local_00000000000000000000000000',
  name: 'Fresh Local',
  slug: 'fresh-local-123456',
  root: '/Users/dev/fresh-local',
  attached: undefined,
  host_id: undefined,
  host_label: undefined,
};

const grove: GroveSummary = {
  id: 'grove_teamprojects00000000000000000000',
  name: 'Team Projects',
  slug: 'team-projects',
  mode: 'local',
  is_default: true,
  created_at: EPOCH,
  project_count: 2,
  projects: [localProject, attachedProject],
};

let currentSelection: ProjectSelection = { grove, project: attachedProject };

mock.module('../../packages/myco/ui/src/providers/power', () => ({
  POWER_MULTIPLIERS: { active: 1, idle: 2, deep_sleep: 5, hidden: 10 },
  usePowerState: () => 'active',
}));
mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectSelection: () => currentSelection,
  useProjectScopedQueryKey: (key: unknown[]) => key,
  projectScopedQueryKey: (_sel: unknown, key: unknown[]) => key,
  useProjectPathBuilder: () => (path?: string) => path ?? '/',
}));

import Dashboard from '../../packages/myco/ui/src/pages/Dashboard';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Zeroed 200 payload per endpoint — a brand-new local project's real reads. */
function zeroBodyForPath(path: string): unknown {
  if (path.includes('/stats')) {
    return {
      context: {
        project: { id: localProject.project_id, name: localProject.name, root: localProject.root, manifest_state: 'present' },
        grove: { id: grove.id, name: grove.name, slug: grove.slug, mode: 'local', binding_id: null, connection_state: 'local-only' },
        request: { source: 'http', project_id: localProject.project_id, grove_id: grove.id, machine_id: 'm', session_id: null },
      },
      daemon: { pid: 1, port: 1, version: '0', uptime_seconds: 0, active_sessions: [] },
      vault: { path: '/x/.myco', name: 'x', session_count: 0, batch_count: 0, spore_count: 0, plan_count: 0, artifact_count: 0, entity_count: 0, edge_count: 0 },
      embedding: { provider: '', model: '', queue_depth: 0, embedded_count: 0, total_embeddable: 0 },
      agent: { last_run_at: null, last_run_status: null, total_runs: 0 },
      digest: { freshest_tier: null, generated_at: null, tiers_available: [] },
      canopy: { entries_count: 0, described_count: 0 },
      unprocessed_batches: 0,
    };
  }
  if (path.includes('/sessions')) return { sessions: [], total: 0, offset: 0, limit: 0 };
  if (path.includes('/agent/runs')) return { runs: [], total: 0, offset: 0, limit: 0 };
  if (path.includes('/skill-records')) return { records: [], total: 0 };
  if (path.includes('/canopy/entries')) return { rows: [], total: 0, limit: 6, offset: 0 };
  return {};
}

const fetchMock = vi.fn((url: string) => Promise.resolve(fetchImpl(url)));
let fetchImpl: (url: string) => Response = () => jsonResponse(200, {});

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The load-bearing zero-state a fresh local project's Dashboard shows. */
async function expectLocalZeroState() {
  // Page head rendered (PageLoading passed through to children) — proves stats resolved.
  await waitFor(() => expect(screen.getByText('Dashboard')).toBeTruthy());
  // The disconnect banner must NOT be present.
  expect(screen.queryByText('Failed to connect to daemon')).toBeNull();
  // The shared zero-state copy each panel renders with no data.
  expect(screen.getByText('No sessions captured yet')).toBeTruthy();
  expect(screen.getByText(/Quiet right now — nothing running/)).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'No active sessions' })).toBeTruthy();
  expect(screen.getByText('No agent runs yet for this project.')).toBeTruthy();
  expect(screen.getByText(/No skills yet/)).toBeTruthy();
  expect(screen.getByText(/Canopy hasn't summarized any files yet/)).toBeTruthy();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Dashboard behaves like a local empty project', () => {
  it('attached + unknown_tenancy 404 on every read → local zero-state, no disconnect banner', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = () => jsonResponse(404, { error: 'unknown_tenancy', message: 'unknown' });
    vi.stubGlobal('fetch', fetchMock);

    renderDashboard();
    await expectLocalZeroState();
    // Behaves like local: the project is still named in its header eyebrow.
    expect(screen.getAllByText('Shared Service').length).toBeGreaterThan(0);
  });

  it('local project + zeroed 200 reads → the same zero-state (baseline)', async () => {
    currentSelection = { grove, project: localProject };
    fetchImpl = (url) => jsonResponse(200, zeroBodyForPath(url));
    vi.stubGlobal('fetch', fetchMock);

    renderDashboard();
    await expectLocalZeroState();
    expect(screen.getAllByText('Fresh Local').length).toBeGreaterThan(0);
  });
});
