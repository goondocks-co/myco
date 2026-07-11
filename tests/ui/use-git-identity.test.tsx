// @vitest-environment jsdom

/**
 * `useGitIdentity`'s hosted-degraded storm fix (consolidation Task D-2
 * degradation UX): `GET /api/git/status` 409s on every request for an
 * attached (hosted) project (`degrade`-stamped in `host/routing.ts`) — left
 * unguarded this became a poll-forever + retry-3-per-poll storm (the "known
 * /api/git/status 409 storm" the task brief names). These tests pin the two
 * knobs that stop it: `retry` never retries the hosted-degraded refusal, and
 * `refetchInterval` stops polling once it's been seen — both keyed off the
 * SAME uniform `hostedDegradedInfo` detector every degraded surface uses.
 */
import { describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import type { Query } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { ApiError } from '../../packages/myco/ui/src/lib/api';
import { POLL_INTERVALS } from '../../packages/myco/ui/src/lib/constants';

const usePowerQueryMock = vi.fn();
mock.module('../../packages/myco/ui/src/hooks/use-power-query', () => ({
  usePowerQuery: (...args: unknown[]) => usePowerQueryMock(...args),
}));

import { useGitIdentity } from '../../packages/myco/ui/src/hooks/use-git-identity';

function hostedRefusal() {
  return new ApiError(409, {
    error: 'capability_unavailable_hosted',
    capability: 'Git provenance',
    message: 'Git provenance is unavailable for projects served by a host in this version.',
    retryable: false,
  });
}

function fakeQuery(error: unknown): Query<unknown, Error, unknown> {
  return { state: { error } } as unknown as Query<unknown, Error, unknown>;
}

describe('useGitIdentity — hosted-degraded 409 storm fix', () => {
  it('refetchInterval stops polling once the hosted-degraded refusal has been seen', () => {
    usePowerQueryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderHook(() => useGitIdentity());

    const call = usePowerQueryMock.mock.calls.at(-1)?.[0] as {
      refetchInterval: (query: Query<unknown, Error, unknown>) => number | false;
    };
    expect(call.refetchInterval(fakeQuery(hostedRefusal()))).toBe(false);
    expect(call.refetchInterval(fakeQuery(null))).toBe(POLL_INTERVALS.GIT_IDENTITY);
    expect(call.refetchInterval(fakeQuery(new Error('transient network blip')))).toBe(POLL_INTERVALS.GIT_IDENTITY);
  });

  it('retry never retries the hosted-degraded refusal, but does retry a transient error (bounded)', () => {
    usePowerQueryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderHook(() => useGitIdentity());

    const call = usePowerQueryMock.mock.calls.at(-1)?.[0] as {
      retry: (failureCount: number, error: unknown) => boolean;
    };
    expect(call.retry(0, hostedRefusal())).toBe(false);
    expect(call.retry(2, hostedRefusal())).toBe(false);
    expect(call.retry(0, new Error('transient'))).toBe(true);
    expect(call.retry(3, new Error('transient'))).toBe(false);
  });
});
