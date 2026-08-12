// @vitest-environment jsdom

/**
 * DiagnosticsCard — whole-card suppression under an attached (hosted)
 * project selection. Mirrors `backup-card-hosted-suppression.test.tsx`'s
 * BackupCard coverage for the identical pattern: all three diagnostics
 * routes (`POST /diagnostics/export`, `GET /diagnostics/exports`,
 * `GET /diagnostics/export/:file/download`) are localhost-only, not
 * degrade-stamped (`host/routing.ts`), so they'd otherwise silently
 * export/list the MEMBER's own local display-Grove data as if it belonged
 * to the team project. Unlike BackupCard (which suppresses the list but
 * keeps the action row's Backup Now visible in some states), DiagnosticsCard
 * suppresses its ENTIRE body (form + result + recent-exports list) under
 * `selection.project.attached === true`, rendering a one-line hosted notice
 * instead. A non-attached selection keeps today's form/list behavior
 * unchanged.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createElement, type ReactNode } from 'react';
import type {
  GroveProjectSummary,
  GroveSummary,
  ProjectSelection,
} from '../../packages/myco/ui/src/lib/selection';

const EPOCH = new Date(0).toISOString();
const HOSTED_NOTICE = "Diagnostic bundles aren't available yet for projects hosted on a Team Host.";

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
  ...attachedProject,
  project_id: 'proj_local_00000000000000000000000000',
  name: 'Local Project',
  slug: 'local-project-123456',
  root: '/Users/dev/local-project',
  attached: undefined,
  host_id: undefined,
  host_label: undefined,
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

let currentSelection: ProjectSelection = { grove, project: attachedProject };

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectSelection: () => currentSelection,
  useActiveProjectSelection: () => currentSelection,
  useProjectScopedQueryKey: (key: unknown[]) => key,
}));

import { DiagnosticsCard } from '../../packages/myco/ui/src/components/operations/DiagnosticsCard';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let exportsCalls = 0;
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = () =>
  Promise.resolve(jsonResponse(200, { exports: [] }));
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  if (url.includes('/diagnostics/exports')) exportsCalls += 1;
  return fetchImpl(url, init);
});

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, node)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  exportsCalls = 0;
  fetchImpl = () => Promise.resolve(jsonResponse(200, { exports: [] }));
});

const ONE_EXPORT = {
  exports: [{ file_name: 'myco-diagnostic-grove_teamprojects-20260812T000000Z.zip', size_bytes: 2048, modified_at: EPOCH }],
};

describe('DiagnosticsCard whole-card suppression under an attached selection', () => {
  it('attached selection: renders the hosted notice, hides the form, and never calls GET /diagnostics/exports', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = (url) => {
      if (url.includes('/diagnostics/exports')) return Promise.resolve(jsonResponse(200, ONE_EXPORT));
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(DiagnosticsCard, { embedded: true }));

    await waitFor(() => expect(screen.getByText(HOSTED_NOTICE)).toBeDefined());
    // Not merely disabled — absent, same posture as BackupCard's action-row
    // suppression (a disabled Export would read as a live, just-empty form).
    expect(screen.queryByRole('button', { name: /^Export$/ })).toBeNull();
    expect(screen.queryByLabelText(/Describe what happened/i)).toBeNull();
    expect(screen.queryByText(/Recent exports/i)).toBeNull();
    expect(screen.queryByText(ONE_EXPORT.exports[0].file_name)).toBeNull();
    // The query never fires at all — nothing to suppress-and-hide.
    expect(exportsCalls).toBe(0);
  });

  it('non-attached selection: the form renders normally, and the recent exports list loads — no hosted notice', async () => {
    currentSelection = { grove, project: localProject };
    fetchImpl = (url) => {
      if (url.includes('/diagnostics/exports')) return Promise.resolve(jsonResponse(200, ONE_EXPORT));
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(DiagnosticsCard, { embedded: true }));

    expect(screen.getByRole('button', { name: /^Export$/ })).toBeDefined();
    expect(screen.getByLabelText(/Describe what happened/i)).toBeDefined();
    await waitFor(() => expect(screen.getByText(ONE_EXPORT.exports[0].file_name)).toBeDefined());
    expect(screen.queryByText(HOSTED_NOTICE)).toBeNull();
    expect(exportsCalls).toBeGreaterThan(0);
  });
});
