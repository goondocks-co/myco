// @vitest-environment jsdom

/**
 * Team Host membership hooks (consolidation Task D-2): the status query, the
 * four mutations (join/leave/attach/detach), and the drain-health query
 * (Task C-5's status API — first UI consumer). Mirrors
 * `tests/ui/use-content-claims.test.tsx`'s mocking shape: `usePowerQuery`
 * and `fetchJson`/`postJson` are mocked so these tests pin the hooks' OWN
 * job — query key/interval, request body, and post-mutation invalidation —
 * without a real network or daemon.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { POLL_INTERVALS } from '../../packages/myco/ui/src/lib/constants';

const usePowerQueryMock = vi.fn();
mock.module('../../packages/myco/ui/src/hooks/use-power-query', () => ({
  usePowerQuery: (...args: unknown[]) => usePowerQueryMock(...args),
}));

const postJsonMock = vi.fn();
const fetchJsonMock = vi.fn();
mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  postJson: (...args: unknown[]) => postJsonMock(...args),
  putJson: async () => ({}),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
}));

import {
  useHostMembershipStatus,
  useJoinHost,
  useLeaveHost,
  useAttachProject,
  useDetachProject,
  useDrainHealth,
  useHostMembershipHealth,
  useResidencyStatus,
  useResidencyAbort,
  type HostMembershipStatusResponse,
} from '../../packages/myco/ui/src/hooks/use-host-membership';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useHostMembershipStatus', () => {
  beforeEach(() => {
    usePowerQueryMock.mockReset();
    fetchJsonMock.mockReset();
  });

  it('polls /host-membership/status at the HOST_MEMBERSHIP interval with no project_root suffix by default', () => {
    const fixture: HostMembershipStatusResponse = { hosts: [], hint: null };
    usePowerQueryMock.mockReturnValue({ data: fixture, isLoading: false, isError: false });

    renderHook(() => useHostMembershipStatus());

    expect(usePowerQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['host-membership-status', null],
        refetchInterval: POLL_INTERVALS.HOST_MEMBERSHIP,
        pollCategory: 'standard',
      }),
    );
  });

  it('appends ?project_root= when a project root is given, keyed on it', async () => {
    usePowerQueryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    fetchJsonMock.mockResolvedValue({ hosts: [], hint: null });

    renderHook(() => useHostMembershipStatus('/checkout with spaces'));

    const call = usePowerQueryMock.mock.calls.at(-1)?.[0] as { queryKey: unknown[]; queryFn: (ctx: { signal?: AbortSignal }) => unknown };
    expect(call.queryKey).toEqual(['host-membership-status', '/checkout with spaces']);

    await call.queryFn({});
    expect(fetchJsonMock).toHaveBeenCalledWith(
      `/host-membership/status?project_root=${encodeURIComponent('/checkout with spaces')}`,
      expect.anything(),
    );
  });
});

describe('useDrainHealth', () => {
  beforeEach(() => {
    usePowerQueryMock.mockReset();
  });

  it('polls /team-host/drain-health at the DRAIN_HEALTH interval', () => {
    usePowerQueryMock.mockReturnValue({ data: { hosts: [] }, isLoading: false, isError: false });
    renderHook(() => useDrainHealth());

    expect(usePowerQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['team-host-drain-health'],
        refetchInterval: POLL_INTERVALS.DRAIN_HEALTH,
        pollCategory: 'standard',
      }),
    );
  });
});

describe('useResidencyStatus', () => {
  type CapturedOptions = {
    queryKey: unknown[];
    enabled: boolean;
    contextFree: boolean;
    queryFn: (ctx: { signal?: AbortSignal }) => unknown;
    refetchInterval: (query: { state: { data: unknown } }) => number | false | undefined;
  };

  beforeEach(() => {
    usePowerQueryMock.mockReset();
    fetchJsonMock.mockReset();
    usePowerQueryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false });
  });

  it('queries residency-status for the project id, context-free, under the standard category', async () => {
    renderHook(() => useResidencyStatus('proj_x', true));

    const call = usePowerQueryMock.mock.calls.at(-1)?.[0] as CapturedOptions;
    expect(call.queryKey).toEqual(['residency-status', 'proj_x']);
    expect(call.enabled).toBe(true);
    expect(call.contextFree).toBe(true);

    fetchJsonMock.mockResolvedValue({ in_flight: false });
    await call.queryFn({});
    expect(fetchJsonMock).toHaveBeenCalledWith(
      `/host-membership/residency-status?project_id=${encodeURIComponent('proj_x')}`,
      expect.anything(),
    );
  });

  it('is disabled when no project id is given, or when the caller has not enabled the watch', () => {
    renderHook(() => useResidencyStatus(undefined, true));
    expect((usePowerQueryMock.mock.calls.at(-1)?.[0] as CapturedOptions).enabled).toBe(false);

    renderHook(() => useResidencyStatus('proj_x', false));
    expect((usePowerQueryMock.mock.calls.at(-1)?.[0] as CapturedOptions).enabled).toBe(false);
  });

  it('self-disarms: polls at RESIDENCY_STATUS while a transition may be running, stops once in_flight is false', () => {
    renderHook(() => useResidencyStatus('proj_x', true));
    const call = usePowerQueryMock.mock.calls.at(-1)?.[0] as CapturedOptions;

    expect(call.refetchInterval({ state: { data: undefined } })).toBe(POLL_INTERVALS.RESIDENCY_STATUS);
    expect(call.refetchInterval({ state: { data: { in_flight: true } } })).toBe(POLL_INTERVALS.RESIDENCY_STATUS);
    expect(call.refetchInterval({ state: { data: { in_flight: false } } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useHostMembershipHealth (E-4 W1 Task T4a/T5, decision-ef693c71 D3) — this
// one is deliberately NOT usePowerQuery-mocked above: it's a plain useQuery,
// so these tests run it against a REAL QueryClient (only fetchJson is mocked)
// to pin the query's actual config, not a hand-rolled assertion about it.
// ---------------------------------------------------------------------------

describe('useHostMembershipHealth', () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function healthWrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  it('fetches /host-membership/health when enabled', async () => {
    fetchJsonMock.mockResolvedValue({ hosts: [] });
    renderHook(() => useHostMembershipHealth(true), { wrapper: healthWrapper });

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith('/host-membership/health', expect.anything()));
  });

  it('does not fetch when disabled, but still reflects the query\'s cached data (attach panel\'s cache-only read)', () => {
    fetchJsonMock.mockResolvedValue({ hosts: [] });
    renderHook(() => useHostMembershipHealth(false), { wrapper: healthWrapper });

    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  // Pins the regression this test was written for: refetchOnWindowFocus and
  // refetchOnReconnect both default to `true` in TanStack Query, and the
  // app's global QueryClient (main.tsx) only overrides staleTime — so
  // without the hook explicitly disabling both, a slideout left open past
  // the 15s staleTime and then refocused (alt-tab back, or any tab
  // visibilitychange) would fire a live overlay probe outside of "panel
  // open + manual refresh," which is exactly what decision-ef693c71 D3
  // forbids. This is a behavioral test (a real focus event against a real
  // QueryClient), not an options-object assertion, so it catches the actual
  // defect rather than pinning a specific call shape.
  it('does not refetch on a window focus event after staleTime has elapsed (decision-ef693c71 D3 — never a background probe)', async () => {
    fetchJsonMock.mockResolvedValue({
      hosts: [{ host_id: 'host_a', label: 'Mac Studio', reachable: true, checked_at: '', protocol_skew: 'none' }],
    });

    const { result } = renderHook(() => useHostMembershipHealth(true), { wrapper: healthWrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);

    // Advance well past the query's 15s staleTime — a query left at its
    // TanStack defaults WOULD be eligible to refetch on the next focus event.
    vi.advanceTimersByTime(20_000);

    // TanStack's FocusManager listens for `visibilitychange` on `window` by
    // default (query-core's focusManager.ts) — this is what a real alt-tab
    // back to the browser tab dispatches.
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
  });
});

describe('mutations', () => {
  beforeEach(() => {
    postJsonMock.mockReset();
  });

  it('useJoinHost posts the full JoinHostInput to /host-membership/join', async () => {
    postJsonMock.mockResolvedValue({
      host_id: 'host_abc', overlay_address: 'a', proxy_port: 1, member_overlay_ip: 'ip', host_reachable: true, created: true, notes: [],
    });
    const { result } = renderHook(() => useJoinHost(), { wrapper });

    result.current.mutate({ host_ref: 'host_abc', key: 'onetime', server_url: 'https://h:8080' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postJsonMock).toHaveBeenCalledWith('/host-membership/join', {
      host_ref: 'host_abc', key: 'onetime', server_url: 'https://h:8080',
    });
  });

  it('useLeaveHost posts { host_ref } to /host-membership/leave', async () => {
    postJsonMock.mockResolvedValue({ removed: true, tailscaled_removed: true, notes: [] });
    const { result } = renderHook(() => useLeaveHost(), { wrapper });

    result.current.mutate('host_abc');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postJsonMock).toHaveBeenCalledWith('/host-membership/leave', { host_ref: 'host_abc' });
  });

  it('useAttachProject posts the AttachProjectInput to /host-membership/attach', async () => {
    postJsonMock.mockResolvedValue({
      project_id: 'proj_x', grove_id: 'grove_x', host_id: 'host_abc', host_label: 'l', root: '/checkout', already_attached: false, notes: [],
    });
    const { result } = renderHook(() => useAttachProject(), { wrapper });

    result.current.mutate({ project_root: '/checkout', host_id: 'host_abc', grove_id: 'grove_x' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postJsonMock).toHaveBeenCalledWith('/host-membership/attach', {
      project_root: '/checkout', host_id: 'host_abc', grove_id: 'grove_x',
    });
  });

  it('useDetachProject posts { project_root, project_id } to /host-membership/detach', async () => {
    postJsonMock.mockResolvedValue({ project_id: 'proj_x', detached_from_host_id: 'host_abc' });
    const { result } = renderHook(() => useDetachProject(), { wrapper });

    result.current.mutate({ project_root: '/checkout' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postJsonMock).toHaveBeenCalledWith('/host-membership/detach', { project_root: '/checkout' });
  });

  it('useDetachProject forwards allow_no_pull when the member accepts the no-data fallback', async () => {
    postJsonMock.mockResolvedValue({ project_id: 'proj_x', detached_from_host_id: 'host_abc' });
    const { result } = renderHook(() => useDetachProject(), { wrapper });

    result.current.mutate({ project_root: '/checkout', project_id: 'proj_x', allow_no_pull: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postJsonMock).toHaveBeenCalledWith('/host-membership/detach', {
      project_root: '/checkout', project_id: 'proj_x', allow_no_pull: true,
    });
  });

  it('useResidencyAbort posts { project_id } to /host-membership/residency-abort', async () => {
    postJsonMock.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useResidencyAbort(), { wrapper });

    result.current.mutate({ project_id: 'proj_x' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postJsonMock).toHaveBeenCalledWith('/host-membership/residency-abort', { project_id: 'proj_x' });
  });

  it('mutations invalidate BOTH the membership status and the degrade-affected git-identity query on settle', async () => {
    // Detach is the case that matters most: useGitIdentity deliberately
    // STOPS polling once it has seen the hosted-degraded 409 (the storm
    // fix), so without an explicit invalidation the topbar git pill would
    // stay stuck in its unavailable state after the project detaches.
    postJsonMock.mockResolvedValue({ project_id: 'proj_x', detached_from_host_id: 'host_abc' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const spyWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useDetachProject(), { wrapper: spyWrapper });
    result.current.mutate({ project_root: '/checkout' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['host-membership-status'] }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['git-identity'] });
    // Also nudges the residency-status watch so the progress line re-arms even
    // when the same project is transitioned again (unchanged query key).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['residency-status'] });
  });

  it('useResidencyAbort invalidates the residency-status watch on settle so the progress line clears', async () => {
    postJsonMock.mockResolvedValue({ ok: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const spyWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useResidencyAbort(), { wrapper: spyWrapper });
    result.current.mutate({ project_id: 'proj_x' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['residency-status'] });
  });
});
