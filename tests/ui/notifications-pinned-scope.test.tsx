// @vitest-environment jsdom
/**
 * Verifies that notification fetch requests carry the SELECTED project's
 * headers even when the ambient request context is null — i.e., when rendered
 * under a machine-scoped page (Symbionts, Logs, Groves, Machine) that sets
 * setCurrentRequestSelection(null).
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GROVE_ID = 'grove-pinned';
const PROJECT_ID = 'project-pinned';

const grove = {
  id: GROVE_ID,
  name: 'Pinned Grove',
  slug: 'pinned',
  mode: 'local' as const,
  is_default: true,
  created_at: '2026-01-01T00:00:00.000Z',
  project_count: 1,
  projects: [
    {
      project_id: PROJECT_ID,
      name: 'Pinned Project',
      slug: 'pinned-proj',
      root: '/tmp/pinned',
      binding_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      manifest_state: 'present' as const,
    },
  ],
};

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any `await import` or hook imports.
// ---------------------------------------------------------------------------

// Stub useGroves so useActiveProjectSelection can resolve the last-selection.
mock.module('../../packages/myco/ui/src/hooks/use-groves', () => ({
  useGroves: () => ({ data: { groves: [grove] } }),
}));

// Stub the PowerProvider dependency of usePowerQuery.
mock.module('../../packages/myco/ui/src/providers/power', () => ({
  POWER_MULTIPLIERS: { active: 1, idle: 2, deep_sleep: 5, hidden: 10 },
  usePowerState: () => 'active',
  PowerProvider: ({ children }: { children: ReactNode }) => children,
}));

// Stub useProjectScopedQueryKey (used by usePowerQuery) to be a pass-through
// so we don't need a full project-scope context to render.
mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectScopedQueryKey: (queryKey: unknown[]) => queryKey,
  useProjectSelection: () => null,
  useActiveProjectSelection: () => {
    // Resolve from localStorage via the real selectionFromLast logic —
    // but since we've mocked useGroves above, we can import the real
    // selectionFromLast to keep the lookup authentic. However, to keep
    // this test isolated we return the selection directly here.
    return { grove, project: grove.projects[0] };
  },
}));

// ---------------------------------------------------------------------------
// Import hooks AFTER mocks.
// ---------------------------------------------------------------------------
import { setCurrentRequestSelection } from '../../packages/myco/ui/src/lib/selection';
import { useUnreadCount, useNotifications } from '../../packages/myco/ui/src/hooks/use-notifications';

// ---------------------------------------------------------------------------
// Test wrapper
// ---------------------------------------------------------------------------

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notifications pinned scope — machine-page simulation', () => {
  beforeEach(() => {
    // Simulate a machine-scoped page: no ambient request context.
    setCurrentRequestSelection(null);
    vi.unstubAllGlobals();
  });

  it('useUnreadCount carries the selected project headers despite null ambient context', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ count: 3 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useUnreadCount(), { wrapper: makeWrapper() });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const callHeaders = fetchMock.mock.calls[0][1].headers as Headers;
    expect(callHeaders.get('x-myco-grove-id')).toBe(GROVE_ID);
    expect(callHeaders.get('x-myco-project-id')).toBe(PROJECT_ID);
  });

  it('useNotifications carries the selected project headers despite null ambient context', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ items: [], unread_count: 0 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useNotifications({ refetchInterval: false }), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const callHeaders = fetchMock.mock.calls[0][1].headers as Headers;
    expect(callHeaders.get('x-myco-grove-id')).toBe(GROVE_ID);
    expect(callHeaders.get('x-myco-project-id')).toBe(PROJECT_ID);
  });
});
