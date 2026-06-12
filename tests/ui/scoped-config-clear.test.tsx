// @vitest-environment jsdom
/**
 * RC-11 regression — clearing a field from the UI must reach the API as a
 * `clear` list, the only unset convention the daemon accepts.
 *
 * The two dead conventions this replaces:
 *  - `undefined` leaf → vanishes from JSON → empty patch → 400 "patch or
 *    clear required"
 *  - explicit `null` leaf → fails Zod (`z.string().optional()` rejects null)
 *
 * These tests drive the real `useScopedConfigForSelection` write layer over
 * a stubbed fetch and assert the wire payload for all three tiers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from '../helpers/vi-shim.js';
import { useScopedConfigForSelection } from '../../packages/myco/ui/src/hooks/use-scoped-config';

type FetchCall = [string | URL | Request, (RequestInit | undefined)?];

let fetchMock: ReturnType<typeof vi.fn>;

function putCallTo(pathFragment: string): { url: string; body: unknown } | undefined {
  const call = (fetchMock.mock.calls as FetchCall[]).find(([url, init]) => {
    return String(url).includes(pathFragment) && init?.method === 'PUT';
  });
  if (!call) return undefined;
  return { url: String(call[0]), body: JSON.parse(String(call[1]?.body)) };
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('useScopedConfig clear routing (RC-11)', () => {
  beforeEach(() => {
    fetchMock = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('/groves')) {
        return Promise.resolve(Response.json({ groves: [] }));
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('setField(path, undefined, grove) PUTs /grove-config with a clear list and no patch', async () => {
    const { result } = renderHook(() => useScopedConfigForSelection(null), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.setField('backup.dir', undefined, 'grove');
    });

    const put = putCallTo('/grove-config');
    expect(put).toBeDefined();
    expect(put!.body).toEqual({ clear: ['backup.dir'] });
  });

  it('setField(path, undefined, machine) PUTs /machine-config with a clear list', async () => {
    const { result } = renderHook(() => useScopedConfigForSelection(null), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.setField('daemon.log_level', undefined, 'machine');
    });

    const put = putCallTo('/machine-config');
    expect(put).toBeDefined();
    expect(put!.body).toEqual({ clear: ['daemon.log_level'] });
  });

  it('setField(path, undefined, project) PUTs /config/scoped with an empty patch and a clear list', async () => {
    const { result } = renderHook(() => useScopedConfigForSelection(null), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.setField('release_provenance.enabled', undefined, 'project');
    });

    const put = putCallTo('/config/scoped');
    expect(put).toBeDefined();
    expect(put!.body).toEqual({
      scope: 'project',
      patch: {},
      clear: ['release_provenance.enabled'],
    });
  });

  it('setFields treats undefined values as clears and sends patch + clear atomically', async () => {
    const { result } = renderHook(() => useScopedConfigForSelection(null), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.setFields(
        [
          { path: 'agent.scheduled_tasks_enabled', value: false },
          { path: 'agent.provider', value: undefined },
        ],
        'grove',
        ['agent.harness'],
      );
    });

    const put = putCallTo('/grove-config');
    expect(put).toBeDefined();
    expect(put!.body).toEqual({
      patch: { agent: { scheduled_tasks_enabled: false } },
      clear: ['agent.harness', 'agent.provider'],
    });
  });
});
