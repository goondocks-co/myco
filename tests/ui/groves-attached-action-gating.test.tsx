// @vitest-environment jsdom
/**
 * Groves page — attached vs local project action-menu gating (Team Host E-4
 * W1 fix-wave finding #1). An attached project (`project.attached === true`,
 * the T3 host-merge synthetic row) has no local Grove state: Move, Ignore,
 * Archive, and Delete are local-lifecycle ops with no legitimate target on a
 * host-owned row (Move is explicitly deferred to a later window), so the
 * full `ProjectActionMenu` must not render for it — only navigation
 * ("Open") is meaningful. A local (non-attached) project keeps the full
 * menu unchanged.
 */
import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
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
      project(),
      project({
        project_id: 'proj_attached',
        name: 'Attached Project',
        slug: 'attached-project-def456',
        root: null,
        attached: true,
        host_id: 'host_1',
        host_label: 'Mac Studio',
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
          <Route path="*" element={<div data-testid="navigated-away" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Groves project action-menu gating (attached vs local)', () => {
  it('shows an Open-only affordance for an attached row — no actions dropdown', () => {
    render(wrap());
    expect(screen.queryByRole('button', { name: 'Attached Project actions' })).toBeNull();
    expect(screen.getByRole('button', { name: /open attached project/i })).toBeInTheDocument();
  });

  it("navigates when the attached row's Open affordance is clicked", () => {
    render(wrap());
    fireEvent.click(screen.getByRole('button', { name: /open attached project/i }));
    expect(screen.getByTestId('navigated-away')).toBeInTheDocument();
  });

  it('shows the full ProjectActionMenu (Move/Ignore/Archive/Delete) for a local, non-attached row', () => {
    render(wrap());
    fireEvent.click(screen.getByRole('button', { name: 'Local Project actions' }));
    expect(screen.getByRole('menuitem', { name: 'Move to another Grove' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Ignore project…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Archive project' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete permanently…' })).toBeInTheDocument();
  });
});
