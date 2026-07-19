// @vitest-environment jsdom

/**
 * T5 (E-4 W2) family (a) — the serve-stamped Operations reads
 * (`/embedding/details`, `/database/details`) an attached project's Operations
 * page mounts. Pre-first-capture the host 404s them with `unknown_tenancy`;
 * BEHAVE-LIKE-LOCAL maps that to the same zero-state a brand-new local project
 * shows (via `resolveAttachedEmpty` + the two suppression knobs), NOT "Unable to
 * reach daemon" + a retry/poll storm. A real host outage (`host_unreachable`
 * 503) and any refusal on a NON-attached project keep today's real error.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { renderHook, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createElement, type ReactNode } from 'react';
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
  name: 'Local Project',
  slug: 'local-project-123456',
  root: '/Users/dev/local-project',
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
}));

import { useEmbeddingDetails } from '../../packages/myco/ui/src/hooks/use-embedding-details';
import { useDatabaseDetails } from '../../packages/myco/ui/src/hooks/use-database-details';
import { EmbeddingTab } from '../../packages/myco/ui/src/components/operations/EmbeddingTab';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchImpl: (url: string) => Promise<Response> = () =>
  Promise.resolve(jsonResponse(404, { error: 'unknown_tenancy', message: 'unknown' }));
const fetchMock = vi.fn((url: string) => fetchImpl(url));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchImpl = () => Promise.resolve(jsonResponse(404, { error: 'unknown_tenancy', message: 'unknown' }));
});

describe('useEmbeddingDetails against a stubbed host response (attached selection)', () => {
  it('resolves the zeroed embedding details on an unknown_tenancy 404 — no error surfaced', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = () => Promise.resolve(jsonResponse(404, { error: 'unknown_tenancy', message: 'unknown' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useEmbeddingDetails('grove'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.isError).toBe(false);
    expect(result.current.data?.total).toBe(0);
    expect(result.current.data?.provider).toEqual({ name: '', model: '', available: false });
  });

  it('keeps the real error state on a host_unreachable outage', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = () =>
      Promise.resolve(jsonResponse(503, { error: 'host_unreachable', host_id: 'h', message: 'down', retryable: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useEmbeddingDetails('grove'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('keeps the real error state for a NON-attached selection on the same 404', async () => {
    currentSelection = { grove, project: localProject };
    fetchImpl = () => Promise.resolve(jsonResponse(404, { error: 'unknown_tenancy', message: 'unknown' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useEmbeddingDetails('grove'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe('useDatabaseDetails against a stubbed host response (attached selection)', () => {
  it('resolves the zeroed database details on an unknown_tenancy 404 — no error surfaced', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = () => Promise.resolve(jsonResponse(404, { error: 'unknown_tenancy', message: 'unknown' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDatabaseDetails(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.isError).toBe(false);
    expect(result.current.data?.schema.version).toBe(0);
    expect(result.current.data?.tables).toEqual([]);
  });

  it('keeps the real error state on a host_unreachable outage', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = () =>
      Promise.resolve(jsonResponse(503, { error: 'host_unreachable', host_id: 'h', message: 'down', retryable: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDatabaseDetails(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe('EmbeddingTab attached pre-first-capture (criterion 3)', () => {
  it('renders the zero-state body, not "Unable to reach daemon", and does not retry-storm', async () => {
    currentSelection = { grove, project: attachedProject };
    let detailCalls = 0;
    fetchImpl = (url: string) => {
      if (url.includes('/embedding/details')) {
        detailCalls += 1;
      }
      return Promise.resolve(jsonResponse(404, { error: 'unknown_tenancy', message: 'unknown' }));
    };
    vi.stubGlobal('fetch', fetchMock);

    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, null, createElement(EmbeddingTab)),
      ),
    );

    // The normal zero body renders (Namespace Breakdown section present)…
    await waitFor(() => expect(screen.getByText('Namespace Breakdown')).toBeDefined());
    // …and the disconnect banner never appears.
    expect(screen.queryByText(/Unable to reach daemon/)).toBeNull();
    // retry:false on the classified refusal — the details endpoint is hit once.
    await waitFor(() => expect(detailCalls).toBeGreaterThan(0));
    expect(detailCalls).toBe(1);
  });
});
