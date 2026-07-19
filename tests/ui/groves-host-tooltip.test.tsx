// @vitest-environment jsdom
/**
 * Groves page — attached-row "Team" badge tooltip (E-4 W2 Task 7, item a).
 * `host_label` is already on the wire (`GroveProjectSummary.host_label`,
 * `ui/src/lib/selection.ts`) and rendered elsewhere (ProjectSwitcher,
 * HostDetailPanel), but the Groves list badge hard-coded a static
 * "Served by a team host" title, discarding the label. This pins the two
 * observable states: label present → interpolated; label absent → the
 * original static fallback (never a blank/undefined-looking tooltip).
 */
import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function project(overrides: Record<string, unknown> = {}) {
  return {
    project_id: 'proj_local',
    name: 'Local Project',
    slug: 'local-project-abc123',
    root: '/tmp/local-project',
    binding_id: null,
    status: 'active',
    archived_at: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    manifest_state: 'present',
    ...overrides,
  };
}

const groves = [
  {
    id: 'g1',
    name: 'Test Grove',
    slug: 'test',
    mode: 'local',
    is_default: true,
    created_at: '2026-01-01',
    project_count: 2,
    projects: [
      project({
        project_id: 'proj_attached_labeled',
        name: 'Labeled Project',
        slug: 'labeled-project-abc123',
        root: null,
        attached: true,
        host_id: 'host_1',
        host_label: 'Mac Studio',
      }),
      project({
        project_id: 'proj_attached_unlabeled',
        name: 'Unlabeled Project',
        slug: 'unlabeled-project-def456',
        root: null,
        attached: true,
        host_id: 'host_2',
        // host_label deliberately omitted
      }),
    ],
  },
];

mock.module('../../packages/myco/ui/src/hooks/use-groves', () => ({
  useGroves: () => ({ data: { groves }, isLoading: false, error: null }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-maintenance-summary', () => ({
  useProjectsActivity: () => ({
    data: { projects: [], active_window_days: 7, generated_at: '2026-05-15' },
    isLoading: false,
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-grove-mutations', () => ({
  useArchiveProject: () => ({ mutate: () => {} }),
  useSetDefaultGrove: () => ({ mutate: () => {} }),
  useUnarchiveProject: () => ({ mutate: () => {} }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-machine-config', () => ({
  useMachineConfig: () => ({ data: { config: { capture: { ignore: { paths: [] } } } } }),
  useUpdateMachineConfig: () => ({ mutate: () => {} }),
  useAddToMachineConfigList: () => ({ mutate: () => {} }),
  useRemoveFromMachineConfigList: () => ({ mutate: () => {} }),
}));

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: () => new Promise(() => {}),
  postJson: async () => ({}),
  putJson: async () => ({}),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
  ApiError: class extends Error {},
}));

import Groves from '../../packages/myco/ui/src/pages/Groves';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/groves']}>
        <Routes>
          <Route path="/groves" element={<Groves />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Groves attached-row "Team" badge tooltip', () => {
  it('renders "Served by <host_label>" when the wire carries a label', () => {
    render(wrap());
    const badges = screen.getAllByText('Team');
    const labeled = badges.find((el) => el.closest('a')?.textContent?.includes('Labeled Project'));
    expect(labeled).toBeDefined();
    expect(labeled!.getAttribute('title')).toBe('Served by Mac Studio');
  });

  it('falls back to the static title when host_label is absent', () => {
    render(wrap());
    const badges = screen.getAllByText('Team');
    const unlabeled = badges.find((el) => el.closest('a')?.textContent?.includes('Unlabeled Project'));
    expect(unlabeled).toBeDefined();
    expect(unlabeled!.getAttribute('title')).toBe('Served by a team host');
  });
});
