// @vitest-environment jsdom

/**
 * T4 (E-4 W2) — the attached-selection tenancy classifier + shared error→empty
 * mapper + the two suppression knobs each affected hook passes.
 *
 * BEHAVE-LIKE-LOCAL: an attached project's pre-first-capture window (the host
 * 404s knowledge reads with `unknown_tenancy` until T1 registration lands, and
 * a residual attached-config carve can 500 with `attached_config_failed`) must
 * render the SAME zero-state a brand-new local project shows — never "Failed to
 * connect to daemon". These tests pin the precision that keeps a real host
 * outage (`host_unreachable` 503 / relay 5xx / network error) and any refusal
 * on a NON-attached project on today's real error presentation.
 */
import { describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import type { Query, UseQueryResult } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { ApiError } from '../../packages/myco/ui/src/lib/api';
import {
  isAttachedTenancyPending,
  resolveAttachedEmpty,
} from '../../packages/myco/ui/src/lib/degrade';
import { POLL_INTERVALS } from '../../packages/myco/ui/src/lib/constants';
import type {
  GroveProjectSummary,
  GroveSummary,
  ProjectSelection,
} from '../../packages/myco/ui/src/lib/selection';

const EPOCH = new Date(0).toISOString();

const attachedProject: GroveProjectSummary = {
  project_id: 'proj_attached_0000000000000000000000',
  name: 'Shared Service',
  slug: 'shared-service-abcdef',
  root: null,
  binding_id: null,
  status: 'active',
  archived_at: null,
  created_at: EPOCH,
  updated_at: EPOCH,
  manifest_state: 'present',
  attached: true,
  host_id: 'host_mac_studio',
  host_label: 'Mac Studio',
};

const localProject: GroveProjectSummary = {
  project_id: 'proj_local_00000000000000000000000000',
  name: 'Local Project',
  slug: 'local-project-123456',
  root: '/Users/dev/local-project',
  binding_id: 'gbind_x',
  status: 'active',
  archived_at: null,
  created_at: EPOCH,
  updated_at: EPOCH,
  manifest_state: 'present',
};

const grove: GroveSummary = {
  id: 'grove_teamprojects00000000000000000000',
  name: 'Team Projects',
  slug: 'team-projects',
  mode: 'local',
  is_default: true,
  created_at: EPOCH,
  project_count: 2,
  projects: [localProject, attachedProject],
};

const attachedSelection: ProjectSelection = { grove, project: attachedProject };
const localSelection: ProjectSelection = { grove, project: localProject };

function unknownTenancy() {
  return new ApiError(404, { error: 'unknown_tenancy', message: 'unknown project or grove' });
}
function attachedConfigFailed() {
  return new ApiError(500, { error: 'attached_config_failed' });
}
function hostUnreachable() {
  return new ApiError(503, {
    error: 'host_unreachable',
    host_id: 'host_mac_studio',
    message: 'This project is served by host Mac Studio, which is currently unreachable over the overlay.',
    retryable: true,
  });
}
function hostAuthRejected() {
  return new ApiError(502, { error: 'host_auth_rejected', host_id: 'host_mac_studio', message: 'rejected' });
}

describe('isAttachedTenancyPending — precise attached pre-registration classifier', () => {
  it('matches an attached selection refused with unknown_tenancy (404) or attached_config_failed (500)', () => {
    expect(isAttachedTenancyPending(unknownTenancy(), attachedSelection)).toBe(true);
    expect(isAttachedTenancyPending(attachedConfigFailed(), attachedSelection)).toBe(true);
  });

  it('does NOT match a real host outage on an attached project (keeps the real error)', () => {
    expect(isAttachedTenancyPending(hostUnreachable(), attachedSelection)).toBe(false);
    expect(isAttachedTenancyPending(hostAuthRejected(), attachedSelection)).toBe(false);
    expect(isAttachedTenancyPending(new Error('network down'), attachedSelection)).toBe(false);
    expect(isAttachedTenancyPending(new ApiError(502, { error: 'bad_gateway' }), attachedSelection)).toBe(false);
  });

  it('does NOT match any other 404 or a generic 500 on an attached project', () => {
    expect(isAttachedTenancyPending(new ApiError(404, { error: 'not_found' }), attachedSelection)).toBe(false);
    expect(isAttachedTenancyPending(new ApiError(500, { error: 'internal_error' }), attachedSelection)).toBe(false);
    // Right status, wrong code pairing (500 unknown_tenancy / 404 attached_config_failed) must not match.
    expect(isAttachedTenancyPending(new ApiError(500, { error: 'unknown_tenancy' }), attachedSelection)).toBe(false);
    expect(isAttachedTenancyPending(new ApiError(404, { error: 'attached_config_failed' }), attachedSelection)).toBe(false);
  });

  it('does NOT match on a NON-attached selection, even for the exact refusal shapes', () => {
    expect(isAttachedTenancyPending(unknownTenancy(), localSelection)).toBe(false);
    expect(isAttachedTenancyPending(attachedConfigFailed(), localSelection)).toBe(false);
  });

  it('is safe on a null/undefined selection or a null error', () => {
    expect(isAttachedTenancyPending(unknownTenancy(), null)).toBe(false);
    expect(isAttachedTenancyPending(unknownTenancy(), undefined)).toBe(false);
    expect(isAttachedTenancyPending(null, attachedSelection)).toBe(false);
    expect(isAttachedTenancyPending(undefined, attachedSelection)).toBe(false);
  });
});

function errorResult<T>(error: unknown): UseQueryResult<T> {
  return {
    data: undefined,
    error,
    isError: true,
    isSuccess: false,
    isPending: false,
    isLoading: false,
    isLoadingError: true,
    isRefetchError: false,
    status: 'error',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<T>;
}

function successResult<T>(data: T): UseQueryResult<T> {
  return {
    data,
    error: null,
    isError: false,
    isSuccess: true,
    isPending: false,
    isLoading: false,
    isLoadingError: false,
    isRefetchError: false,
    status: 'success',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<T>;
}

describe('resolveAttachedEmpty — the one shared error→empty mapping', () => {
  const EMPTY = { items: [] as string[], total: 0 };

  it('maps a classified refusal to the empty shape with no error state', () => {
    const mapped = resolveAttachedEmpty(errorResult(unknownTenancy()), attachedSelection, EMPTY);
    expect(mapped.isError).toBe(false);
    expect(mapped.error).toBeNull();
    expect(mapped.isSuccess).toBe(true);
    expect(mapped.status).toBe('success');
    expect(mapped.data).toEqual(EMPTY);
  });

  it('invokes a builder empty with the (attached) selection', () => {
    const mapped = resolveAttachedEmpty(
      errorResult(attachedConfigFailed()),
      attachedSelection,
      (s) => ({ items: [s.project.name], total: 0 }),
    );
    expect(mapped.data).toEqual({ items: ['Shared Service'], total: 0 });
  });

  it('leaves a real host outage on its real error state (no fake empty page)', () => {
    const original = errorResult(hostUnreachable());
    expect(resolveAttachedEmpty(original, attachedSelection, EMPTY)).toBe(original);
  });

  it('leaves a non-attached refusal and any success result untouched', () => {
    const refused = errorResult(unknownTenancy());
    expect(resolveAttachedEmpty(refused, localSelection, EMPTY)).toBe(refused);
    const ok = successResult({ items: ['x'], total: 1 });
    expect(resolveAttachedEmpty(ok, attachedSelection, EMPTY)).toBe(ok);
  });
});

// ---------------------------------------------------------------------------
// Suppression knobs — the two `use-git-identity.ts` knobs, and ONLY those two.
// usePowerQuery is mocked so we can inspect the exact options each hook passes.
// ---------------------------------------------------------------------------

let currentSelection: ProjectSelection | null = attachedSelection;

const usePowerQueryMock = vi.fn(() => ({ isError: false, data: undefined }));
mock.module('../../packages/myco/ui/src/hooks/use-power-query', () => ({
  usePowerQuery: (...args: unknown[]) => usePowerQueryMock(...args),
}));
mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectSelection: () => currentSelection,
  useProjectScopedQueryKey: (key: unknown[]) => key,
}));

import { useDaemon } from '../../packages/myco/ui/src/hooks/use-daemon';
import { useSessions } from '../../packages/myco/ui/src/hooks/use-sessions';

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

describe('affected hooks pass exactly two suppression knobs (attached selection)', () => {
  it('useDaemon: retry never retries the tenancy refusal; refetchInterval stops polling on it', () => {
    currentSelection = attachedSelection;
    renderHook(() => useDaemon());
    const opts = capturedOptions();

    expect(opts.retry(0, unknownTenancy())).toBe(false);
    expect(opts.retry(0, attachedConfigFailed())).toBe(false);
    expect(opts.retry(0, hostUnreachable())).toBe(true);
    expect(opts.retry(0, new Error('blip'))).toBe(true);
    expect(opts.retry(3, new Error('blip'))).toBe(false);

    expect(opts.refetchInterval(fakeQuery(unknownTenancy()))).toBe(false);
    expect(opts.refetchInterval(fakeQuery(null))).toBe(POLL_INTERVALS.STATS);
    expect(opts.refetchInterval(fakeQuery(hostUnreachable()))).toBe(POLL_INTERVALS.STATS);
  });

  it('useSessions: same two knobs, keyed off the same classifier', () => {
    currentSelection = attachedSelection;
    renderHook(() => useSessions({ status: 'active', limit: 6 }));
    const opts = capturedOptions();

    expect(opts.retry(0, unknownTenancy())).toBe(false);
    expect(opts.retry(0, new Error('blip'))).toBe(true);
    expect(opts.refetchInterval(fakeQuery(unknownTenancy()))).toBe(false);
    expect(opts.refetchInterval(fakeQuery(null))).toBe(POLL_INTERVALS.SESSIONS);
  });

  it('does NOT touch the recovery knobs (refetchOnWindowFocus/refetchOnMount/retryOnMount)', () => {
    currentSelection = attachedSelection;
    renderHook(() => useDaemon());
    const opts = capturedOptions();
    // Absent → they keep their TanStack default (true), which is the recovery
    // path: once T1 registration lands, a focus/mount refetch repopulates.
    expect('refetchOnWindowFocus' in opts).toBe(false);
    expect('refetchOnMount' in opts).toBe(false);
    expect('retryOnMount' in opts).toBe(false);
  });

  it('on a NON-attached selection the knobs never suppress (real errors survive)', () => {
    currentSelection = localSelection;
    renderHook(() => useSessions({ limit: 1 }));
    const opts = capturedOptions();
    expect(opts.retry(0, unknownTenancy())).toBe(true);
    expect(opts.refetchInterval(fakeQuery(unknownTenancy()))).toBe(POLL_INTERVALS.SESSIONS);
  });
});
