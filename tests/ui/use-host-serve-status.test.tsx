// @vitest-environment jsdom
/**
 * useHostServeStatus (E-4 W1 Task T6, consuming Task T4b's
 * GET /api/host-serve/status) — pins the hook's OWN job: query key, poll
 * category, endpoint, and the conditional `refetchInterval`. Mirrors
 * tests/ui/use-host-membership.test.tsx's mocking shape (usePowerQuery and
 * fetchJson mocked so these assert the hook's config, not a real network).
 *
 * `refetchInterval` here is a FUNCTION rather than a fixed
 * `POLL_INTERVALS` value (unlike useHostMembershipStatus/useDrainHealth),
 * so it can turn itself off once the answer is `{serving:false}` — the 99%
 * case, where neither dashboard card renders anything a poll could
 * usefully refresh. These tests capture that function and invoke it with
 * synthetic query states, the same technique use-power-query.test.tsx uses
 * for its own interval-callback case.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { vi } from '../helpers/vi-shim.js';
import { POLL_INTERVALS } from '../../packages/myco/ui/src/lib/constants';

const usePowerQueryMock = vi.fn();
mock.module('../../packages/myco/ui/src/hooks/use-power-query', () => ({
  usePowerQuery: (...args: unknown[]) => usePowerQueryMock(...args),
}));

const fetchJsonMock = vi.fn();
mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}));

import { useHostServeStatus } from '../../packages/myco/ui/src/hooks/use-host-serve-status';

type CapturedOptions = {
  queryFn: (ctx: { signal?: AbortSignal }) => unknown;
  refetchInterval: (query: { state: { data: unknown } }) => number | false | undefined;
};

describe('useHostServeStatus', () => {
  beforeEach(() => {
    usePowerQueryMock.mockReset();
    fetchJsonMock.mockReset();
    usePowerQueryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false });
  });

  it('queries /host-serve/status under the standard power category, scoped by ["host-serve-status"]', async () => {
    renderHook(() => useHostServeStatus());

    expect(usePowerQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['host-serve-status'],
        pollCategory: 'standard',
        // Machine-global posture, not project-scoped — see use-host-serve-status.ts.
        contextFree: true,
      }),
    );

    const call = usePowerQueryMock.mock.calls.at(-1)?.[0] as CapturedOptions;
    fetchJsonMock.mockResolvedValue({ serving: false });
    await call.queryFn({});
    expect(fetchJsonMock).toHaveBeenCalledWith('/host-serve/status', expect.anything());
  });

  it('keeps refetchInterval at the base HOST_SERVE_STATUS interval while data is unknown or serving is true', () => {
    renderHook(() => useHostServeStatus());
    const call = usePowerQueryMock.mock.calls.at(-1)?.[0] as CapturedOptions;

    expect(call.refetchInterval({ state: { data: undefined } })).toBe(POLL_INTERVALS.HOST_SERVE_STATUS);
    expect(call.refetchInterval({ state: { data: { serving: true } } })).toBe(POLL_INTERVALS.HOST_SERVE_STATUS);
  });

  it('turns refetchInterval off once the response is {serving:false} — nothing on screen a poll could refresh', () => {
    renderHook(() => useHostServeStatus());
    const call = usePowerQueryMock.mock.calls.at(-1)?.[0] as CapturedOptions;

    expect(call.refetchInterval({ state: { data: { serving: false } } })).toBe(false);
  });
});
