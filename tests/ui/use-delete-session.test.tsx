// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const deleteJsonMock = vi.fn();

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: async () => ({}),
  postJson: async () => ({}),
  putJson: async () => ({}),
  patchJson: async () => ({}),
  deleteJson: (path: string, body?: unknown) => deleteJsonMock(path, body),
  ApiError: class extends Error {},
}));

import { useDeleteSession } from '../../packages/myco/ui/src/hooks/use-sessions';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useDeleteSession', () => {
  beforeEach(() => {
    deleteJsonMock.mockReset();
    deleteJsonMock.mockResolvedValue({ ok: true, counts: {} });
  });

  it('sends no body for a plain delete', async () => {
    const { result } = renderHook(() => useDeleteSession(), { wrapper });

    result.current.mutate({ id: 'sess-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(deleteJsonMock).toHaveBeenCalledWith('/sessions/sess-1', undefined);
  });

  it('sends {force: true} when retrying past the 409 session_live refusal', async () => {
    const { result } = renderHook(() => useDeleteSession(), { wrapper });

    result.current.mutate({ id: 'sess-2', force: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(deleteJsonMock).toHaveBeenCalledWith('/sessions/sess-2', { force: true });
  });
});
