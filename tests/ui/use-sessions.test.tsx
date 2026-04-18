// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POLL_INTERVALS } from '../../packages/myco/ui/src/lib/constants';
import { useSessionPlans } from '../../packages/myco/ui/src/hooks/use-sessions';

const usePowerQueryMock = vi.fn();

vi.mock('../../packages/myco/ui/src/hooks/use-power-query', () => ({
  usePowerQuery: (...args: unknown[]) => usePowerQueryMock(...args),
}));

vi.mock('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: vi.fn(),
  deleteJson: vi.fn(),
  postJson: vi.fn(),
}));

describe('useSessionPlans', () => {
  beforeEach(() => {
    usePowerQueryMock.mockReset();
    usePowerQueryMock.mockReturnValue({ data: [], isLoading: false, isError: false });
  });

  it('polls live session plans through usePowerQuery', () => {
    renderHook(() => useSessionPlans('sess-1'));

    expect(usePowerQueryMock).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: ['session-plans', 'sess-1'],
      enabled: true,
      pollCategory: 'standard',
      refetchInterval: POLL_INTERVALS.STATS,
    }));
  });
});
