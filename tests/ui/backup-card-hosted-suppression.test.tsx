// @vitest-environment jsdom

/**
 * BackupCard — backups list AND action-row suppression under an attached
 * selection (LOCKED decision D-W2-4, E-4 W2 Task 7 item f). `GET
 * /api/backups` is localhost-only, not degrade-stamped — unlike the
 * backup/restore MUTATIONS (also covered by
 * tests/ui/operations-mutations-degrade.test.tsx, "BackupCard create
 * mutation", against a non-attached/stale-client selection to keep exercising
 * the server-side degrade defense) — so it succeeds under an attached
 * selection and would otherwise list the MEMBER's own local display-Grove
 * backups as if they belonged to the team project: actively misleading. This
 * suppresses the list AND the Refresh/Restore…/Backup Now action row under
 * `selection.project.attached === true`, rendering a one-line hosted notice
 * instead of a card whose Restore… trigger would otherwise be permanently,
 * silently disabled (indistinguishable from the ordinary "no backups yet"
 * state). A non-attached selection keeps today's list/actions/error behavior
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
const HOSTED_NOTICE = "This project's team storage is backed up by its host.";

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

mock.module('../../packages/myco/ui/src/providers/power', () => ({
  POWER_MULTIPLIERS: { active: 1, idle: 2, deep_sleep: 5, hidden: 10 },
  usePowerState: () => 'active',
}));
mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectSelection: () => currentSelection,
  useActiveProjectSelection: () => currentSelection,
  useProjectScopedQueryKey: (key: unknown[]) => key,
}));

import { BackupCard } from '../../packages/myco/ui/src/components/operations/BackupCard';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let backupsCalls = 0;
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = () =>
  Promise.resolve(jsonResponse(200, { backups: [] }));
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  if (url.includes('/backups')) backupsCalls += 1;
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
  backupsCalls = 0;
  fetchImpl = () => Promise.resolve(jsonResponse(200, { backups: [] }));
});

const ONE_BACKUP = {
  backups: [{ file_name: 'a.tar.gz', modified_at: EPOCH, size_bytes: 1024, machine_id: 'machine-1' }],
};

describe('BackupCard backups-list suppression under an attached selection (family f)', () => {
  it('attached selection: suppresses the list, renders the hosted notice, and never calls GET /backups', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = (url) => {
      if (url.includes('/backups')) return Promise.resolve(jsonResponse(200, ONE_BACKUP));
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(BackupCard, { embedded: true }));

    await waitFor(() => expect(screen.getByText(HOSTED_NOTICE)).toBeDefined());
    expect(screen.queryByText(/No backups yet/)).toBeNull();
    expect(screen.queryByText(/backup.*kept/i)).toBeNull();
    expect(screen.queryByText('machine-1')).toBeNull();
    // The query never fires at all — nothing to suppress-and-hide.
    expect(backupsCalls).toBe(0);
  });

  it('attached selection: hides the entire action row — no Backup Now, Restore…, or Refresh triggers', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = (url) => {
      if (url.includes('/backups')) return Promise.resolve(jsonResponse(200, ONE_BACKUP));
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(BackupCard, { embedded: true }));

    await waitFor(() => expect(screen.getByText(HOSTED_NOTICE)).toBeDefined());
    // Not merely disabled — absent. A disabled Restore… would be
    // indistinguishable from the ordinary "no backups yet" state.
    expect(screen.queryByRole('button', { name: /Backup Now/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
    expect(backupsCalls).toBe(0);
  });

  it('non-attached selection: the list renders normally (unchanged) — no hosted notice', async () => {
    currentSelection = { grove, project: localProject };
    fetchImpl = (url) => {
      if (url.includes('/backups')) return Promise.resolve(jsonResponse(200, ONE_BACKUP));
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(BackupCard, { embedded: true }));

    await waitFor(() => expect(screen.getByText(/1 backup kept/)).toBeDefined());
    expect(screen.queryByText(HOSTED_NOTICE)).toBeNull();
    expect(backupsCalls).toBeGreaterThan(0);
  });

  it('non-attached selection: the full action row renders exactly as before — Refresh, Restore…, Backup Now', async () => {
    currentSelection = { grove, project: localProject };
    fetchImpl = (url) => {
      if (url.includes('/backups')) return Promise.resolve(jsonResponse(200, ONE_BACKUP));
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(BackupCard, { embedded: true }));

    // Wait for the backups fetch to resolve before checking Restore…'s
    // enabled state — it starts disabled (backups.length === 0) until data
    // loads, same as pre-fix behavior.
    await waitFor(() => expect(screen.getByText(/1 backup kept/)).toBeDefined());
    expect(screen.getByRole('button', { name: /Backup Now/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeDefined();
    const restoreButton = screen.getByRole('button', { name: /Restore/ }) as HTMLButtonElement;
    expect(restoreButton.disabled).toBe(false);
    expect(screen.queryByText(HOSTED_NOTICE)).toBeNull();
  });

  it('non-attached selection: an empty list still renders "No backups yet" (unchanged) — no hosted notice', async () => {
    currentSelection = { grove, project: localProject };
    fetchImpl = (url) => {
      if (url.includes('/backups')) return Promise.resolve(jsonResponse(200, { backups: [] }));
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(BackupCard, { embedded: true }));

    await waitFor(() => expect(screen.getByText(/No backups yet/)).toBeDefined());
    expect(screen.queryByText(HOSTED_NOTICE)).toBeNull();
  });

  it('non-attached selection: a 503 on the list still errors normally, never swallowed by the hosted notice', async () => {
    currentSelection = { grove, project: localProject };
    fetchImpl = (url) => {
      if (url.includes('/backups')) return Promise.resolve(jsonResponse(503, { error: 'host_unreachable', message: 'down' }));
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(BackupCard, { embedded: true }));

    await waitFor(() => expect(screen.getByText(/Failed to load backups/)).toBeDefined());
    expect(screen.queryByText(HOSTED_NOTICE)).toBeNull();
  });
});
