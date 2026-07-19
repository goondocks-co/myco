// @vitest-environment jsdom

/**
 * T5 (E-4 W2) family (d) — Operations MUTATIONS (actions, not polls). Backup,
 * embedding maintenance, and DB maintenance mutations are degrade-stamped for
 * attached (hosted) projects: they 409 capability_unavailable_hosted. On that
 * classified refusal the surface renders the uniform HostedUnavailable strip in
 * its error slot instead of a raw "Error: …" / "Backup failed: …". A real
 * failure (503) keeps today's raw error text.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createElement, type ReactNode } from 'react';
import type {
  GroveProjectSummary,
  GroveSummary,
  ProjectSelection,
} from '../../packages/myco/ui/src/lib/selection';

const EPOCH = new Date(0).toISOString();
const HOSTED_MESSAGE = /isn't available for projects hosted on a Team Host yet/;

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

// BackupCard now hides its entire action row (Refresh/Restore…/Backup Now)
// under an attached selection (LOCKED D-W2-4, item f) — the button that
// these BackupCard mutation tests click can no longer render for an attached
// selection. This represents a stale/racy client (selection cache hasn't
// caught up to a project just becoming hosted) so the button is still
// visible client-side while the server independently degrade-stamps the
// mutation — the defense-in-depth scenario `hostedDegradedInfo` exists for.
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

import { EmbeddingTab } from '../../packages/myco/ui/src/components/operations/EmbeddingTab';
import { BackupCard } from '../../packages/myco/ui/src/components/operations/BackupCard';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const EMBEDDING_DETAILS_OK = {
  total: 0,
  by_namespace: {},
  models: {},
  pending: {},
  provider: { name: 'openai', model: 'text-embedding-3-small', available: true },
};

const refusal = () =>
  jsonResponse(409, {
    error: 'capability_unavailable_hosted',
    capability: 'Embedding maintenance',
    message: 'Embedding maintenance is unavailable for projects served by a host in this version.',
    retryable: false,
  });
const outage = () => jsonResponse(503, { error: 'host_unreachable', host_id: 'h', message: 'down', retryable: true });

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = () => Promise.resolve(jsonResponse(200, {}));
const fetchMock = vi.fn((url: string, init?: RequestInit) => fetchImpl(url, init));

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, node)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchImpl = () => Promise.resolve(jsonResponse(200, {}));
  currentSelection = { grove, project: attachedProject };
});

describe('EmbeddingTab maintenance mutation (family d)', () => {
  it('renders HostedUnavailable inline when a maintenance action 409s', async () => {
    fetchImpl = (url) => {
      if (url.includes('/embedding/details')) return Promise.resolve(jsonResponse(200, EMBEDDING_DETAILS_OK));
      if (url.includes('/embedding/clean-orphans')) return Promise.resolve(refusal());
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(EmbeddingTab));

    await waitFor(() => expect(screen.getByRole('button', { name: /Clean orphans/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Clean orphans/ }));

    await waitFor(() => expect(screen.getByText(HOSTED_MESSAGE)).toBeDefined());
    expect(screen.queryByText(/^Error:/)).toBeNull();
  });

  it('keeps the raw error text on a real outage (503)', async () => {
    fetchImpl = (url) => {
      if (url.includes('/embedding/details')) return Promise.resolve(jsonResponse(200, EMBEDDING_DETAILS_OK));
      if (url.includes('/embedding/clean-orphans')) return Promise.resolve(outage());
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(EmbeddingTab));

    await waitFor(() => expect(screen.getByRole('button', { name: /Clean orphans/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Clean orphans/ }));

    await waitFor(() => expect(screen.getByText(/Error:/)).toBeDefined());
    expect(screen.queryByText(HOSTED_MESSAGE)).toBeNull();
  });
});

describe('BackupCard create mutation (family d)', () => {
  it('renders HostedUnavailable inline when Backup Now 409s', async () => {
    // Non-attached selection so Backup Now still renders (BackupCard hides
    // the action row outright for an attached selection, item f) — this
    // exercises the server's independent degrade-stamp as a stale-client
    // defense, not the client-side attached check.
    currentSelection = { grove, project: localProject };
    fetchImpl = (url) => {
      if (url.includes('/backups')) return Promise.resolve(jsonResponse(200, { backups: [] }));
      if (url.includes('/backup')) return Promise.resolve(
        jsonResponse(409, {
          error: 'capability_unavailable_hosted',
          capability: 'Backup and restore',
          message: 'Backup and restore is unavailable for projects served by a host in this version.',
          retryable: false,
        }),
      );
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(BackupCard, { embedded: true }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Backup Now/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Backup Now/ }));

    await waitFor(() => expect(screen.getByText(HOSTED_MESSAGE)).toBeDefined());
    expect(screen.queryByText(/Backup failed/)).toBeNull();
  });

  it('keeps the raw error text on a real outage (503)', async () => {
    currentSelection = { grove, project: localProject };
    fetchImpl = (url) => {
      if (url.includes('/backups')) return Promise.resolve(jsonResponse(200, { backups: [] }));
      if (url.includes('/backup')) return Promise.resolve(outage());
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(BackupCard, { embedded: true }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Backup Now/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Backup Now/ }));

    await waitFor(() => expect(screen.getByText(/Backup failed/)).toBeDefined());
    expect(screen.queryByText(HOSTED_MESSAGE)).toBeNull();
  });

  it('attached selection: hides Backup Now entirely — the action row is suppressed, not disabled', async () => {
    currentSelection = { grove, project: attachedProject };
    fetchImpl = (url) => {
      if (url.includes('/backups')) return Promise.resolve(jsonResponse(200, { backups: [] }));
      return Promise.resolve(jsonResponse(200, {}));
    };
    vi.stubGlobal('fetch', fetchMock);
    wrap(createElement(BackupCard, { embedded: true }));

    await waitFor(() =>
      expect(screen.getByText("This project's team storage is backed up by its host.")).toBeDefined(),
    );
    expect(screen.queryByRole('button', { name: /Backup Now/ })).toBeNull();
  });
});
