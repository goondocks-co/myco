// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { useScopedConfig } from '../../packages/myco/ui/src/hooks/use-scoped-config';

const invalidateQueriesMock = vi.fn();
const writeScopedConfigMock = vi.fn();
const clearLocalConfigKeysMock = vi.fn();

mock.module('@tanstack/react-query', () => ({
  useQuery: vi.fn(({ queryKey }: { queryKey: readonly string[] }) => ({
    data: queryKey[1] === 'merged'
      ? {
          notifications: { enabled: true, system_notifications: false, default_mode: 'summary', domains: {} },
          cortex: { spores: { inject_on_prompt_submit: true } },
        }
      : {},
    isLoading: false,
  })),
  useQueryClient: () => ({
    invalidateQueries: invalidateQueriesMock,
  }),
}));

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchMergedConfig: vi.fn(),
  fetchLocalConfig: vi.fn(),
  writeScopedConfig: (...args: unknown[]) => writeScopedConfigMock(...args),
  clearLocalConfigKeys: (...args: unknown[]) => clearLocalConfigKeysMock(...args),
}));

describe('useScopedConfig', () => {
  beforeEach(() => {
    invalidateQueriesMock.mockReset();
    writeScopedConfigMock.mockReset();
    clearLocalConfigKeysMock.mockReset();
    writeScopedConfigMock.mockResolvedValue(undefined);
    clearLocalConfigKeysMock.mockResolvedValue(undefined);
  });

  it('invalidates notification queries after a settings write', async () => {
    const { result } = renderHook(() => useScopedConfig());

    await act(async () => {
      await result.current.setField('cortex.spores.inject_on_prompt_submit', false, 'project');
    });

    expect(writeScopedConfigMock).toHaveBeenCalledWith('project', {
      cortex: { spores: { inject_on_prompt_submit: false } },
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['notifications'] });
  });
});
