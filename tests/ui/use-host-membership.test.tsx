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
import { beforeEach, describe, expect, it, mock } from 'bun:test';
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
});
