// @vitest-environment jsdom

/**
 * T4 (E-4 W2) — end-to-end through the REAL `usePowerQuery` path: a stubbed
 * `fetch` returns the host's `unknown_tenancy` 404, and `useSessions` resolves
 * to the empty list (isError cleared) instead of surfacing an error — while a
 * real `host_unreachable` outage and a NON-attached refusal both keep their
 * real error state. Recovery: once the fetch flips to real data, a refetch
 * (the `refetchOnWindowFocus`/`refetchOnMount` recovery path, simulated here
 * with an explicit refetch) repopulates the list.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

import { useSessions } from '../../packages/myco/ui/src/hooks/use-sessions';
import { useSkillCandidates } from '../../packages/myco/ui/src/hooks/use-skills';
import { emptyStatsForSelection } from '../../packages/myco/ui/src/hooks/use-daemon';

describe('emptyStatsForSelection — zeroed stats carrying the selection identity', () => {
  it('zeros every count while naming the project and grove from the selection', () => {
    const stats = emptyStatsForSelection({ grove, project: attachedProject });
    expect(stats.context.project.name).toBe('Shared Service');
    expect(stats.context.project.id).toBe(attachedProject.project_id);
    expect(stats.context.grove.name).toBe('Team Projects');
    expect(stats.context.grove.slug).toBe('team-projects');
    // Every surfaced count is zero — the local zero-session shape.
    expect(stats.vault.session_count).toBe(0);
    expect(stats.vault.spore_count).toBe(0);
    expect(stats.vault.plan_count).toBe(0);
    expect(stats.canopy.entries_count).toBe(0);
    expect(stats.canopy.described_count).toBe(0);
    expect(stats.embedding.total_embeddable).toBe(0);
    expect(stats.embedding.queue_depth).toBe(0);
    expect(stats.agent.total_runs).toBe(0);
  });

  it('tolerates a null attached-project root (renders as an empty string)', () => {
    const stats = emptyStatsForSelection({ grove, project: attachedProject });
    expect(stats.context.project.root).toBe('');
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchImpl: () => Promise<Response> = () => Promise.resolve(jsonResponse(200, { sessions: [], total: 0, offset: 0, limit: 0 }));
const fetchMock = vi.fn(() => fetchImpl());

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchImpl = () => Promise.resolve(jsonResponse(200, { sessions: [], total: 0, offset: 0, limit: 0 }));
});

describe('useSessions against a stubbed host response (attached selection)', () => {
  it('resolves the empty list on an unknown_tenancy 404 — no error surfaced', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = () => Promise.resolve(jsonResponse(404, { error: 'unknown_tenancy', message: 'unknown' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSessions({ status: 'active', limit: 6 }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toEqual({ sessions: [], total: 0, offset: 0, limit: 0 });
  });

  it('keeps the real error state on a host_unreachable outage (no fake empty page)', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = () =>
      Promise.resolve(jsonResponse(503, { error: 'host_unreachable', host_id: 'h', message: 'down', retryable: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSessions({ limit: 6 }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('keeps the real error state for a NON-attached selection on the same 404', async () => {
    currentSelection = { grove, project: localProject };
    fetchImpl = () => Promise.resolve(jsonResponse(404, { error: 'unknown_tenancy', message: 'unknown' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSessions({ limit: 6 }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('recovers: once the host returns real data, a refetch repopulates the list', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = () => Promise.resolve(jsonResponse(404, { error: 'unknown_tenancy', message: 'unknown' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSessions({ limit: 6 }), { wrapper: wrapper() });

    // First: the pre-registration empty state.
    await waitFor(() => expect(result.current.data).toEqual({ sessions: [], total: 0, offset: 0, limit: 0 }));

    // The first forwarded capture registers the project host-side.
    fetchImpl = () =>
      Promise.resolve(
        jsonResponse(200, {
          sessions: [
            {
              id: 's1',
              date: '2026-07-18',
              title: 'First captured session',
              status: 'active',
              agent: 'claude-code',
              prompt_count: 1,
              tool_count: 0,
              started_at: 1779100000,
              ended_at: null,
              activity_buckets: [1],
              branch: 'main',
            },
          ],
          total: 1,
          offset: 0,
          limit: 6,
        }),
      );

    await result.current.refetch();

    await waitFor(() => expect(result.current.data?.sessions.length).toBe(1));
    expect(result.current.isError).toBe(false);
    expect(result.current.data?.sessions[0]?.title).toBe('First captured session');
  });
});

describe('useSkillCandidates against a stubbed host response (attached selection)', () => {
  it('resolves the empty list on an unknown_tenancy 404 — no error surfaced, no retry', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = () => Promise.resolve(jsonResponse(404, { error: 'unknown_tenancy', message: 'unknown' }));
    vi.stubGlobal('fetch', fetchMock);
    const callsBefore = fetchMock.mock.calls.length;

    const { result } = renderHook(() => useSkillCandidates({ status: 'identified' }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toEqual({ candidates: [], total: 0 });
    // retry: false on the classified refusal — exactly one fetch, no retries.
    expect(fetchMock.mock.calls.length - callsBefore).toBe(1);
  });

  it('keeps the real error state on a host_unreachable outage (no fake empty page)', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = () =>
      Promise.resolve(jsonResponse(503, { error: 'host_unreachable', host_id: 'h', message: 'down', retryable: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSkillCandidates({ status: 'identified' }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('keeps the real error state for a NON-attached selection on the same 404', async () => {
    currentSelection = { grove, project: localProject };
    fetchImpl = () => Promise.resolve(jsonResponse(404, { error: 'unknown_tenancy', message: 'unknown' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSkillCandidates({ status: 'identified' }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
