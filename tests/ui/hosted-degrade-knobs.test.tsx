// @vitest-environment jsdom

/**
 * T5 (E-4 W2) families (b)+(c) — the hosted-degrade suppression knobs each
 * usePowerQuery-based read hook passes, keyed off the uniform hosted-degrade
 * detector (`hostedDegradedInfo`). The affected routes are `degrade`-stamped for
 * attached (hosted) projects and 409 capability_unavailable_hosted:
 *   - (b) `useCanopyEntries` polls, so it passes BOTH knobs (retry +
 *     refetchInterval) — criterion 2: no interval refetch under a classified 409;
 *   - (c) `useReleaseProvenanceDetail` never polls, so only the retry knob applies
 *     (refetchInterval is already a static false).
 * A real error keeps today's failureCount<3 / normal poll, and the recovery knobs
 * (refetchOnWindowFocus/refetchOnMount/retryOnMount) are never touched.
 */
import { describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import type { Query } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { ApiError } from '../../packages/myco/ui/src/lib/api';
import { POLL_INTERVALS } from '../../packages/myco/ui/src/lib/constants';

function canopyRefusal() {
  return new ApiError(409, {
    error: 'capability_unavailable_hosted',
    capability: 'Code intelligence (Canopy)',
    message: 'Code intelligence (Canopy) is unavailable for projects served by a host in this version.',
    retryable: false,
  });
}
function otherError() {
  return new Error('transient');
}

const usePowerQueryMock = vi.fn(() => ({ isError: false, data: undefined }));
mock.module('../../packages/myco/ui/src/hooks/use-power-query', () => ({
  usePowerQuery: (...args: unknown[]) => usePowerQueryMock(...args),
}));
mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectSelection: () => null,
  useProjectScopedQueryKey: (key: unknown[]) => key,
}));

import { useCanopyEntries } from '../../packages/myco/ui/src/hooks/use-canopy';
import { useReleaseProvenanceDetail } from '../../packages/myco/ui/src/hooks/use-release-provenance';

function fakeQuery(error: unknown): Query<unknown, Error, unknown> {
  return { state: { error } } as unknown as Query<unknown, Error, unknown>;
}

function capturedOptions() {
  return usePowerQueryMock.mock.calls.at(-1)?.[0] as {
    retry: (failureCount: number, err: unknown) => boolean;
    refetchInterval: (query: Query<unknown, Error, unknown>) => number | false;
    [key: string]: unknown;
  };
}

describe('useCanopyEntries suppression knobs (hosted-degrade 409)', () => {
  it('never retries the degraded refusal; keeps failureCount<3 for real errors', () => {
    renderHook(() => useCanopyEntries({ limit: 6 }));
    const opts = capturedOptions();
    expect(opts.retry(0, canopyRefusal())).toBe(false);
    expect(opts.retry(0, otherError())).toBe(true);
    expect(opts.retry(3, otherError())).toBe(false);
  });

  it('stops polling on the degraded refusal; keeps the base interval otherwise', () => {
    renderHook(() => useCanopyEntries({ limit: 6 }));
    const opts = capturedOptions();
    expect(opts.refetchInterval(fakeQuery(canopyRefusal()))).toBe(false);
    expect(opts.refetchInterval(fakeQuery(null))).toBe(POLL_INTERVALS.CANOPY_ENTRIES);
    // A real transient error must keep polling (it is not a hosted degrade).
    expect(opts.refetchInterval(fakeQuery(otherError()))).toBe(POLL_INTERVALS.CANOPY_ENTRIES);
  });

  it('does NOT touch the recovery knobs', () => {
    renderHook(() => useCanopyEntries({ limit: 6 }));
    const opts = capturedOptions();
    expect('refetchOnWindowFocus' in opts).toBe(false);
    expect('refetchOnMount' in opts).toBe(false);
    expect('retryOnMount' in opts).toBe(false);
  });
});

describe('useReleaseProvenanceDetail suppression knob (hosted-degrade 409)', () => {
  it('never retries the degraded refusal; keeps failureCount<3 for real errors', () => {
    renderHook(() => useReleaseProvenanceDetail('sessions', 'sess-1', true));
    const opts = capturedOptions();
    expect(opts.retry(0, canopyRefusal())).toBe(false);
    expect(opts.retry(0, otherError())).toBe(true);
    expect(opts.retry(3, otherError())).toBe(false);
  });

  it('does not poll (refetchInterval is a static false) and never touches recovery knobs', () => {
    renderHook(() => useReleaseProvenanceDetail('sessions', 'sess-1', true));
    const opts = capturedOptions();
    expect(opts.refetchInterval).toBe(false);
    expect('refetchOnWindowFocus' in opts).toBe(false);
    expect('refetchOnMount' in opts).toBe(false);
    expect('retryOnMount' in opts).toBe(false);
  });
});
