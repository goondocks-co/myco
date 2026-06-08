// @vitest-environment jsdom
/**
 * Groves card — capability badge strip.
 *
 * Pins the post-review contract: the badge strip is ONE clickable
 * <button> that opens the per-project CapabilityPanel — not a set of
 * nested <Link>s deep-linking to a non-existent
 * `/g/.../p/.../settings#...` route. Renders the real Groves page with
 * a single capture-only project and asserts:
 *   - the strip is a button (not an anchor)
 *   - it shows the "Capture-only" badge text
 *   - clicking it opens the CapabilityPanel slide-out
 */

import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
          project_count: 1,
          projects: [
            {
              project_id: 'proj_capture_only',
              name: 'Capture Only',
              slug: 'capture-only-abc123',
              root: '/tmp/capture-only',
              binding_id: null,
              status: 'active',
              archived_at: null,
              created_at: '2026-01-01',
              updated_at: '2026-01-01',
              manifest_state: 'present',
              // All opt-in capabilities off → single "Capture-only" badge.
              capabilities: { cortex: false, canopy: false, skills: false, vault_evolution: false },
            },
          ],
        },
      ],
    },
    isLoading: false,
    error: null,
  }),
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

// CapabilityPanel reads merged + local config via fetchJson; a never-resolving
// fetch keeps the panel in its loading state, which is enough to prove it opened.
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
        <Groves />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Groves capability badge strip', () => {
  it('renders the strip as a button (not a Link) showing Capture-only', () => {
    render(wrap());
    const strip = screen.getByTestId('capability-badge-strip');
    expect(strip.tagName).toBe('BUTTON');
    // The broken deep-link is gone: no anchor wraps the badge visuals.
    expect(strip.querySelector('a')).toBeNull();
    expect(strip).toHaveTextContent('Capture-only');
  });

  it('opens the per-project CapabilityPanel on click', async () => {
    render(wrap());
    expect(screen.queryByTestId('capability-panel-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('capability-badge-strip'));
    await waitFor(() => {
      expect(screen.getByTestId('capability-panel-panel')).toBeInTheDocument();
    });
  });
});
