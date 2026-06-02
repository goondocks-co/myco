// @vitest-environment jsdom
/**
 * Unit tests for the useScopedConfig hook.
 */

import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* ---------- API stubs ---------- */

const writeScopedConfigMock = vi.fn();
const putJsonMock = vi.fn();
const clearLocalConfigKeysMock = vi.fn();
const fetchJsonMock = vi.fn();

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  writeScopedConfig: (...args: unknown[]) => writeScopedConfigMock(...args),
  putJson: (...args: unknown[]) => putJsonMock(...args),
  patchJson: vi.fn(),
  postJson: vi.fn(),
  deleteJson: vi.fn(),
  clearLocalConfigKeys: (...args: unknown[]) => clearLocalConfigKeysMock(...args),
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  fetchMergedConfig: () => Promise.resolve({}),
  fetchLocalConfig: () => Promise.resolve({}),
}));

// Import AFTER mocks so the module binds to the stubs above.
const { useScopedConfig } = await import('../../packages/myco/ui/src/hooks/use-scoped-config');

/* ---------- Wrapper ---------- */

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

/* ---------- Tests ---------- */

describe('useScopedConfig.setField', () => {
  beforeEach(() => {
    writeScopedConfigMock.mockReset();
    putJsonMock.mockReset();
    clearLocalConfigKeysMock.mockReset();
    fetchJsonMock.mockReset();

    writeScopedConfigMock.mockResolvedValue(undefined);
    putJsonMock.mockResolvedValue(undefined);
    clearLocalConfigKeysMock.mockResolvedValue(undefined);
    fetchJsonMock.mockResolvedValue({});
  });

  it("scope 'project' routes to writeScopedConfig, not putJson grove-config", async () => {
    const { result } = renderHook(() => useScopedConfig(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.setField('agent.model', 'claude-opus-4', 'project');
    });
    expect(writeScopedConfigMock).toHaveBeenCalledWith(
      'project',
      { agent: { model: 'claude-opus-4' } },
      undefined,
      {},
    );
    expect(putJsonMock).not.toHaveBeenCalledWith(
      '/grove-config',
      expect.anything(),
    );
  });

  it("scope 'local' routes to writeScopedConfig, not putJson grove-config", async () => {
    const { result } = renderHook(() => useScopedConfig(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.setField('agent.model', 'claude-sonnet-4-5', 'local');
    });
    expect(writeScopedConfigMock).toHaveBeenCalledWith(
      'local',
      { agent: { model: 'claude-sonnet-4-5' } },
      undefined,
      {},
    );
    expect(putJsonMock).not.toHaveBeenCalledWith('/grove-config', expect.anything());
  });

  it("scope 'grove' routes to PUT /grove-config with { patch } body", async () => {
    const { result } = renderHook(() => useScopedConfig(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.setField('agent.model', 'claude-opus-4', 'grove');
    });
    expect(putJsonMock).toHaveBeenCalledWith('/grove-config', {
      patch: { agent: { model: 'claude-opus-4' } },
    }, {
      headers: {},
    });
    expect(writeScopedConfigMock).not.toHaveBeenCalled();
  });

  it("scope 'grove' sends a correctly nested patch for a deep dotted path", async () => {
    const { result } = renderHook(() => useScopedConfig(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.setField('agent.model', 'my-model', 'grove');
    });
    expect(putJsonMock).toHaveBeenCalledWith('/grove-config', {
      patch: { agent: { model: 'my-model' } },
    }, {
      headers: {},
    });
  });

  it("scope 'grove' does not call writeScopedConfig", async () => {
    const { result } = renderHook(() => useScopedConfig(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.setField('agent.model', 'my-model', 'grove');
    });
    expect(writeScopedConfigMock).not.toHaveBeenCalled();
  });

  it("scope 'machine' routes to PUT /machine-config with { patch } body", async () => {
    // capture.* / notifications.* moved to Machine tier (2026-06 correction);
    // their cards write through the 'machine' scope, which must hit
    // /machine-config — never the project scoped-config endpoint.
    const { result } = renderHook(() => useScopedConfig(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.setField('notifications.enabled', false, 'machine');
    });
    expect(putJsonMock).toHaveBeenCalledWith('/machine-config', {
      patch: { notifications: { enabled: false } },
    });
    expect(writeScopedConfigMock).not.toHaveBeenCalled();
  });

  it("scope 'machine' sends a correctly nested patch for a deep dotted path", async () => {
    const { result } = renderHook(() => useScopedConfig(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.setField('capture.buffer_max_events', 250, 'machine');
    });
    expect(putJsonMock).toHaveBeenCalledWith('/machine-config', {
      patch: { capture: { buffer_max_events: 250 } },
    });
    expect(writeScopedConfigMock).not.toHaveBeenCalled();
  });
});
