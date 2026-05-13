// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { POLL_INTERVALS } from '../../packages/myco/ui/src/lib/constants';
import { useSpores } from '../../packages/myco/ui/src/hooks/use-spores';

const useQueryMock = vi.fn();

mock.module('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: vi.fn(),
}));

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectScopedQueryKey: (key: unknown[]) => key,
}));

describe('useSpores', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  });

  it('polls the spore list at the SPORES interval', () => {
    renderHook(() => useSpores());

    expect(useQueryMock).toHaveBeenCalledWith(expect.objectContaining({
      refetchInterval: POLL_INTERVALS.SPORES,
    }));
  });
});
