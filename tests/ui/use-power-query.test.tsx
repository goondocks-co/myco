import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useQueryMock = vi.fn();
let powerStateMock: 'active' | 'idle' | 'deep_sleep' | 'hidden' = 'active';

vi.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock('../../packages/myco/ui/src/providers/power', () => ({
  POWER_MULTIPLIERS: {
    active: 1,
    idle: 2,
    deep_sleep: 5,
    hidden: 10,
  },
  usePowerState: () => powerStateMock,
}));

vi.mock('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectScopedQueryKey: (queryKey: unknown[]) => ['scoped', ...queryKey],
}));

import { usePowerQuery } from '../../packages/myco/ui/src/hooks/use-power-query';

describe('usePowerQuery', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue({ data: null });
    powerStateMock = 'active';
  });

  it('scales fixed refetch intervals by power state', () => {
    powerStateMock = 'idle';

    renderHook(() =>
      usePowerQuery({
        queryKey: ['stats'],
        queryFn: async () => ({ ok: true }),
        pollCategory: 'standard',
        refetchInterval: 1_000,
      }),
    );

    expect(useQueryMock).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: ['scoped', 'stats'],
      refetchInterval: 2_000,
    }));
  });

  it('keeps terminal-aware interval callbacks power-managed', () => {
    powerStateMock = 'idle';

    renderHook(() =>
      usePowerQuery({
        queryKey: ['progress', 'token'],
        queryFn: async () => ({ status: 'running' }),
        pollCategory: 'realtime',
        refetchInterval: (query) => query.state.data?.status === 'done' ? false : 500,
      }),
    );

    const options = useQueryMock.mock.calls[0]?.[0] as {
      refetchInterval: (query: { state: { data?: { status: string } } }) => number | false;
    };

    expect(options.refetchInterval({ state: { data: { status: 'running' } } })).toBe(1_000);
    expect(options.refetchInterval({ state: { data: { status: 'done' } } })).toBe(false);
  });
});
