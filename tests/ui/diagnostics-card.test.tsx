// @vitest-environment jsdom
/**
 * DiagnosticsCard — happy-path render + export flow (Task 10).
 *
 * Mirrors `backup-card-hosted-suppression.test.tsx`'s harness: mock
 * `use-project-selection` to a fixed non-attached selection, stub global
 * `fetch` (DiagnosticsCard calls `fetchJson`, which itself calls `fetch`,
 * plus a raw `fetch` for the download route), and assert on the POST body
 * shape the brief pins down (scope + include_content + narrative + window,
 * epoch-second window bounds) and that the result row renders after a
 * successful export.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createElement, type ReactNode } from 'react';
import type {
  GroveProjectSummary,
  GroveSummary,
  ProjectSelection,
} from '../../packages/myco/ui/src/lib/selection';

const EPOCH = new Date(0).toISOString();

const localProject: GroveProjectSummary = {
  project_id: 'proj_local_00000000000000000000000000',
  name: 'Local Project',
  slug: 'local-project-123456',
  root: '/Users/dev/local-project',
  binding_id: null,
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
  project_count: 1,
  projects: [localProject],
};

const currentSelection: ProjectSelection = { grove, project: localProject };

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectSelection: () => currentSelection,
  useActiveProjectSelection: () => currentSelection,
  useProjectScopedQueryKey: (key: unknown[]) => key,
}));

import { DiagnosticsCard } from '../../packages/myco/ui/src/components/operations/DiagnosticsCard';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let postCalls: Array<{ url: string; body: unknown }> = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = () =>
  Promise.resolve(jsonResponse(200, { exports: [] }));

const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  if (init?.method === 'POST' && url.includes('/diagnostics/export')) {
    postCalls.push({ url, body: init.body ? JSON.parse(init.body as string) : null });
  }
  return fetchImpl(url, init);
});

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, node)));
}

afterEach(() => {
  vi.unstubAllGlobals();
  postCalls = [];
  fetchImpl = () => Promise.resolve(jsonResponse(200, { exports: [] }));
});

const EXPORT_RESPONSE = {
  file_path: '/home/user/myco_diagnostics/myco-diagnostic-grove_teamprojects-20260812T000000Z.zip',
  file_name: 'myco-diagnostic-grove_teamprojects-20260812T000000Z.zip',
  size_bytes: 204800,
  manifest: { files: [] },
};

describe('DiagnosticsCard', () => {
  it('renders the card title, fills the narrative, and posts the expected body shape on Export', async () => {
    fetchImpl = (url, init) => {
      if (url.includes('/diagnostics/exports')) return Promise.resolve(jsonResponse(200, { exports: [] }));
      if (init?.method === 'POST' && url.includes('/diagnostics/export')) {
        return Promise.resolve(jsonResponse(200, EXPORT_RESPONSE));
      }
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);

    wrap(createElement(DiagnosticsCard, { embedded: true }));

    expect(screen.getByText('Export diagnostic bundle')).toBeDefined();

    const narrativeBox = screen.getByLabelText(/Describe what happened/i) as HTMLTextAreaElement;
    fireEvent.change(narrativeBox, { target: { value: 'Capture stopped mid-session.' } });

    fireEvent.click(screen.getByRole('button', { name: /^Export$/ }));

    await waitFor(() => expect(postCalls.length).toBe(1));
    const { body } = postCalls[0] as { body: Record<string, unknown> };
    expect(body.scope).toEqual({ kind: 'grove', grove_id: grove.id });
    expect(body.include_content).toBe(false);
    expect(body.narrative).toBe('Capture stopped mid-session.');
    expect(body.session_id).toBeUndefined();
    const window = body.window as { since: number; until: number };
    expect(typeof window.since).toBe('number');
    expect(typeof window.until).toBe('number');
    expect(window.until).toBeGreaterThan(window.since);
    // "last-24h" default preset: 86400s span, epoch seconds not ms.
    expect(window.until - window.since).toBe(86400);
    expect(window.until).toBeLessThan(10_000_000_000); // sanity: seconds, not ms

    await waitFor(() => expect(screen.getByText(EXPORT_RESPONSE.file_name)).toBeDefined());
    expect(screen.getByText('200 KB')).toBeDefined();
  });

  it('sends session_id instead of window when the Session ID field is non-empty', async () => {
    fetchImpl = (url, init) => {
      if (url.includes('/diagnostics/exports')) return Promise.resolve(jsonResponse(200, { exports: [] }));
      if (init?.method === 'POST' && url.includes('/diagnostics/export')) {
        return Promise.resolve(jsonResponse(200, EXPORT_RESPONSE));
      }
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);

    wrap(createElement(DiagnosticsCard, { embedded: true }));

    const sessionInput = screen.getByLabelText(/Session ID/i) as HTMLInputElement;
    fireEvent.change(sessionInput, { target: { value: 'sess_abc123' } });
    fireEvent.click(screen.getByRole('button', { name: /^Export$/ }));

    await waitFor(() => expect(postCalls.length).toBe(1));
    const { body } = postCalls[0] as { body: Record<string, unknown> };
    expect(body.session_id).toBe('sess_abc123');
    expect(body.window).toBeUndefined();
  });

  it('renders "Nothing recorded in that window." on an empty_window 404, without leaking the raw error code', async () => {
    fetchImpl = (url, init) => {
      if (url.includes('/diagnostics/exports')) return Promise.resolve(jsonResponse(200, { exports: [] }));
      if (init?.method === 'POST' && url.includes('/diagnostics/export')) {
        return Promise.resolve(
          jsonResponse(404, {
            error: 'empty_window',
            nearest_sessions: [{ id: 'sess_1', started_at: 1_700_000_000 }],
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);

    wrap(createElement(DiagnosticsCard, { embedded: true }));
    fireEvent.click(screen.getByRole('button', { name: /^Export$/ }));

    await waitFor(() => expect(screen.getByText('Nothing recorded in that window.')).toBeDefined());
    expect(screen.queryByText(/empty_window/)).toBeNull();
  });
});
