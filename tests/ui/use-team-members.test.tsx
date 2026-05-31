// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { POLL_INTERVALS } from '../../packages/myco/ui/src/lib/constants';
import {
  useTeamMembers,
  type TeamMembersResponse,
} from '../../packages/myco/ui/src/hooks/use-team-members';

const usePowerQueryMock = vi.fn();
const fetchJsonMock = vi.fn();

mock.module('../../packages/myco/ui/src/hooks/use-power-query', () => ({
  usePowerQuery: (...args: unknown[]) => usePowerQueryMock(...args),
}));

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  postJson: async () => ({}),
  putJson: async () => ({}),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
}));

const fixture: TeamMembersResponse = {
  members: [
    {
      id: 'm1',
      user: 'Alice',
      role: 'owner',
      joined: '2026-04-01',
      tags: ['core'],
      machine_id: 'machine-1',
      synced_at: null,
    },
  ],
};

describe('useTeamMembers', () => {
  beforeEach(() => {
    usePowerQueryMock.mockReset();
    fetchJsonMock.mockReset();
    fetchJsonMock.mockResolvedValue(fixture);
    usePowerQueryMock.mockReturnValue({
      data: fixture,
      isLoading: false,
      isError: false,
    });
  });

  it('polls /team/members through usePowerQuery at the STATS interval', () => {
    const { result } = renderHook(() => useTeamMembers());

    expect(usePowerQueryMock).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: ['team-members', null],
      refetchInterval: POLL_INTERVALS.STATS,
      pollCategory: 'standard',
    }));

    const call = usePowerQueryMock.mock.calls[0]![0] as {
      queryFn: (ctx: { signal: AbortSignal }) => Promise<TeamMembersResponse>;
    };
    const controller = new AbortController();
    void call.queryFn({ signal: controller.signal });
    expect(fetchJsonMock).toHaveBeenCalledWith('/team/members', { signal: controller.signal });

    expect(result.current.data!.members[0]!.user).toBe('Alice');
  });
});
