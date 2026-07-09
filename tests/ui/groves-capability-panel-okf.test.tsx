// @vitest-environment jsdom

/**
 * Groves CapabilityPanel — OKF row (Plan 3's registry auto-populates this;
 * this test pins the OKF-specific contract).
 *
 * Covers: the OKF row appears (driven by CAPABILITY_IDS, which now
 * includes 'okf'); its toggle calls `setFields([{path:'okf.enabled',...}],
 * 'local')` — Personal/local scope, deliberately different from the OKF
 * page's ScopedField (project scope); "Advanced settings" link points at
 * `/okf`.
 */

import { describe, expect, it, mock } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from '../helpers/vi-shim.js';
import type { GroveSummary, GroveProjectSummary } from '../../packages/myco/ui/src/lib/selection';

const fetchJsonImpl = async (path: string) => {
  if (path === '/config/merged') return { okf: { enabled: false } };
  if (path === '/config/local') return {};
  return {};
};
const fetchJsonSpy = vi.fn((path: string) => fetchJsonImpl(path));
const putJsonSpy = vi.fn(async () => ({}));

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (path: string) => fetchJsonSpy(path),
  postJson: async () => ({}),
  putJson: (path: string, body: unknown) => putJsonSpy(path, body),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
  fetchMergedConfig: () => fetchJsonSpy('/config/merged'),
  fetchLocalConfig: () => fetchJsonSpy('/config/local'),
  writeScopedConfig: (scope: string, patch: Record<string, unknown>, clear?: string[]) =>
    putJsonSpy('/config/scoped', clear && clear.length > 0 ? { scope, patch, clear } : { scope, patch }),
  clearLocalConfigKeys: (keys: string[]) => putJsonSpy('/config/scoped', { scope: 'local', patch: {}, clear: keys }),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown) {
      super(`API error ${status}`);
    }
  },
}));

const { CapabilityPanel } = await import('../../packages/myco/ui/src/components/groves/CapabilityPanel');

const grove: GroveSummary = {
  id: 'grove-a',
  name: 'Work',
  slug: 'work',
  mode: 'local',
  is_default: true,
  created_at: '2026-01-01T00:00:00.000Z',
  project_count: 1,
  projects: [],
};

const project: GroveProjectSummary = {
  project_id: 'project-a',
  name: 'Project A',
  slug: 'project-a-123abc',
  root: '/tmp/project-a',
  binding_id: 'gbind-a',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  manifest_state: 'present',
};

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CapabilityPanel target={{ grove, project }} open onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Groves CapabilityPanel — OKF row', () => {
  it('renders an OKF row from the CAPABILITY_IDS registry', async () => {
    renderPanel();
    expect(await screen.findByText('OKF')).toBeInTheDocument();
  });

  it('advanced settings link points at /okf', async () => {
    renderPanel();
    await screen.findByText('OKF');
    const links = screen.getAllByRole('link', { name: /advanced settings/i });
    const okfLink = links.find((l) => l.getAttribute('href') === '/okf');
    expect(okfLink).toBeDefined();
  });

  it('toggling the OKF switch calls setFields([{path:"okf.enabled",...}], "local")', async () => {
    renderPanel();
    await screen.findByText('OKF');

    // Rows render in CAPABILITY_IDS order: cortex, canopy, skills,
    // vault_evolution, okf — OKF's switch is the last one.
    const switches = screen.getAllByRole('switch');
    const okfSwitch = switches[switches.length - 1];
    fireEvent.click(okfSwitch);

    await waitFor(() => {
      expect(putJsonSpy).toHaveBeenCalled();
    });
    const [path, body] = putJsonSpy.mock.calls[0] as [string, { scope: string; patch: unknown }];
    expect(path).toBe('/config/scoped');
    expect(body.scope).toBe('local');
    expect(body.patch).toEqual({ okf: { enabled: true } });
  });
});
