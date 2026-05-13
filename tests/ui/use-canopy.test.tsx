// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { POLL_INTERVALS } from '../../packages/myco/ui/src/lib/constants';
import { useCanopyEntries } from '../../packages/myco/ui/src/hooks/use-canopy';

const useQueryMock = vi.fn();

mock.module('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useMutation: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  fetchJson: vi.fn(),
  postJson: vi.fn(),
}));

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectScopedQueryKey: (key: unknown[]) => key,
}));

describe('useCanopyEntries', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  });

  it('polls canopy entries at the CANOPY_ENTRIES interval', () => {
    renderHook(() => useCanopyEntries({}));

    expect(useQueryMock).toHaveBeenCalledWith(expect.objectContaining({
      refetchInterval: POLL_INTERVALS.CANOPY_ENTRIES,
    }));
  });
});
