// @vitest-environment jsdom
/**
 * useRunEvents accumulates lifecycle events across polls client-side — the
 * `GET /agent/runs/:id/events` endpoint has no cursor field in its response,
 * so the hook derives `?since=` from the max `id` it has already seen and
 * appends new rows rather than replacing state. These tests pin that
 * contract plus the count===1000 immediate-refetch, terminal-status stop,
 * and runId-change reset behaviors against a real QueryClient.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from '../helpers/vi-shim.js';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';
import { useRunEvents, type RunEventRow } from '../../packages/myco/ui/src/hooks/use-agent';

function makeEvent(id: number, overrides: Partial<RunEventRow> = {}): RunEventRow {
  return {
    id,
    run_id: 'run-1',
    phase_name: 'describe',
    event_type: 'pre_tool_use',
    tool_name: 'Read',
    outcome: null,
    duration_ms: null,
    payload: null,
    recorded_at: 1_700_000_000 + id,
    ...overrides,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(PowerProvider, null, createElement(QueryClientProvider, { client: qc }, children));
}

describe('useRunEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accumulates events across polls and advances the cursor from the max id seen', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        return Promise.resolve(Response.json({ events: [makeEvent(1), makeEvent(2)], count: 2 }));
      }
      return Promise.resolve(Response.json({ events: [makeEvent(3)], count: 1 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRunEvents('run-1', 'running'), { wrapper });

    await waitFor(() => expect(result.current.events.length).toBe(2));
    expect(result.current.events.map((e) => e.id)).toEqual([1, 2]);
    expect(calls[0]).toContain('/agent/runs/run-1/events');
    expect(calls[0]).not.toContain('since=');

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.events.length).toBe(3));
    expect(result.current.events.map((e) => e.id)).toEqual([1, 2, 3]);
    // Second request carries the cursor advanced to the max id from the first page.
    expect(calls[1]).toContain('since=2');
  });

  it('immediately refetches when a page comes back at the server limit (1000)', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => makeEvent(i + 1));
    const calls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        return Promise.resolve(Response.json({ events: fullPage, count: 1000 }));
      }
      return Promise.resolve(Response.json({ events: [makeEvent(1001)], count: 1 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRunEvents('run-1', 'running'), { wrapper });

    // The count===1000 page triggers an automatic follow-up fetch without
    // the test driving refetch() itself.
    await waitFor(() => expect(calls.length).toBe(2), { timeout: 3000 });
    await waitFor(() => expect(result.current.events.length).toBe(1001));
    expect(calls[1]).toContain('since=1000');
  });

  it('stops polling once runStatus is terminal (fetches once)', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ events: [makeEvent(1)], count: 1 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRunEvents('run-1', 'completed'), { wrapper });

    await waitFor(() => expect(result.current.events.length).toBe(1));
    expect(result.current.isFetching).toBe(false);
    // No refetchInterval is wired for a terminal run — nothing should
    // schedule a second call on its own.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resets accumulated events and the cursor when runId changes', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      calls.push(url);
      if (url.includes('run-1')) {
        return Promise.resolve(Response.json({ events: [makeEvent(1), makeEvent(2)], count: 2 }));
      }
      return Promise.resolve(Response.json({ events: [makeEvent(50)], count: 1 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(
      ({ runId }: { runId: string }) => useRunEvents(runId, 'completed'),
      { wrapper, initialProps: { runId: 'run-1' } },
    );

    await waitFor(() => expect(result.current.events.length).toBe(2));

    rerender({ runId: 'run-2' });

    await waitFor(() => expect(result.current.events.map((e) => e.id)).toEqual([50]));
    // The fetch for run-2 must not carry a stale since= cursor from run-1.
    const run2Call = calls.find((c) => c.includes('run-2'));
    expect(run2Call).toBeDefined();
    expect(run2Call).not.toContain('since=');
  });

  // Mandatory regression test for the cache-remount corruption bug: with a
  // warm react-query cache, the query key caches only the LAST incremental
  // (`?since=`) page. On remount within gcTime, the old code would replay
  // that cached tail page against freshly-reset (empty) local state,
  // producing a cursor jumped past unseen events / duplicate appends.
  // `gcTime: 0` + `staleTime: 0` force a cold remount; the id-based dedupe
  // is belt-and-braces. Render the hook twice against a SHARED QueryClient
  // (unmount -> remount) and assert no duplicates and full coverage.
  it('starts cold on remount against a shared QueryClient — no duplicates, full coverage', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        // First mount: page 1, cursor advances to id 2.
        return Promise.resolve(Response.json({ events: [makeEvent(1), makeEvent(2)], count: 2 }));
      }
      // Remount: if the hook incorrectly replayed the cached tail page,
      // this response (page "2") would never even be requested with a
      // fresh (cursor-less) query — asserted below via the URL shape.
      return Promise.resolve(Response.json({ events: [makeEvent(1), makeEvent(2), makeEvent(3)], count: 3 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sharedWrapper = ({ children }: { children: ReactNode }) =>
      createElement(PowerProvider, null, createElement(QueryClientProvider, { client: qc }, children));

    const first = renderHook(() => useRunEvents('run-1', 'completed'), { wrapper: sharedWrapper });
    await waitFor(() => expect(first.result.current.events.length).toBe(2));
    expect(first.result.current.events.map((e) => e.id)).toEqual([1, 2]);

    first.unmount();

    // Remount within what would have been gcTime under the old defaults —
    // same QueryClient instance, same query key.
    const second = renderHook(() => useRunEvents('run-1', 'completed'), { wrapper: sharedWrapper });

    await waitFor(() => expect(second.result.current.events.length).toBe(3));
    // No duplicates: exactly one entry per id, full coverage of ids 1-3.
    const ids = second.result.current.events.map((e) => e.id);
    expect(ids).toEqual([1, 2, 3]);
    expect(new Set(ids).size).toBe(ids.length);

    // The remount's request must start cold (no stale since= cursor carried
    // over from the unmounted instance's cached tail page).
    const remountCall = calls[calls.length - 1];
    expect(remountCall).not.toContain('since=');
  });
});
