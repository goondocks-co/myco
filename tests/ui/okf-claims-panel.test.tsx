// @vitest-environment jsdom

/**
 * OKF "Publish" panel (B6, spec §7) — the per-page claim-to-publish
 * affordance on the Okf page. This is the fix for the known Maintain-Now
 * silent-block: a synthesis run that stages new page generations used to end
 * with nothing visible; now every unpublished page shows up here with its own
 * Publish / Release control. Renders the full Okf page (not just
 * the panel — it isn't separately exported) against a mocked `lib/api`, real
 * content-claims hooks.
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';
import type { ProjectSelection } from '../../packages/myco/ui/src/lib/selection';
import type { OkfStatusResponse } from '../../packages/myco/ui/src/hooks/use-okf';
import type { ContentClaimsListResponse, ContentClaimView } from '../../packages/myco/ui/src/hooks/use-content-claims';

/* ---------- Fixtures ---------- */

const SELECTION: ProjectSelection = {
  grove: {
    id: 'grove-a',
    name: 'Work',
    slug: 'work',
    mode: 'local',
    is_default: true,
    created_at: '2026-01-01T00:00:00.000Z',
    project_count: 1,
    projects: [],
  },
  project: {
    project_id: 'project-a',
    name: 'Project A',
    slug: 'project-a-123abc',
    root: '/tmp/project-a',
    binding_id: 'gbind-a',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    manifest_state: 'present',
  },
};

const ENABLED_STATUS: OkfStatusResponse = {
  outputRoot: '/tmp/project-a/docs/okf',
  bundleExists: true,
  claimedBundleExists: true,
  bundleGeneration: 3,
  inputsHash: 'abc123',
  generatedAt: '2026-07-01T00:00:00.000Z',
  lastResult: 'published',
  byType: { concept: 1 },
  pageCount: 1,
  publishAcknowledged: true,
  pendingFindings: [],
  enabled: true,
  outputPath: 'docs/okf',
  validation: { ok: true, level: 'strict', filesChecked: 1, conceptsChecked: 1 },
  agentsPointer: { present: true, stale: false },
  publishEligibility: { ok: true, findings: [] },
  lastRun: null,
};

/* ---------- Mocks ---------- */

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useActiveProjectSelection: () => SELECTION,
  useProjectSelection: () => SELECTION,
  useProjectPath: (suffix = '') => `/g/work/p/project-a-123abc${suffix}`,
  useProjectPathBuilder: () => (suffix = '') => `/g/work/p/project-a-123abc${suffix}`,
  useProjectScopedQueryKey: (key: unknown[]) => [...key, { projectSelection: 'grove-a:project-a' }],
}));

let claimable: ContentClaimsListResponse['claimable'] = [];
let activeClaim: ContentClaimView | null = null;

const fetchJsonMock = vi.fn();
const postJsonMock = vi.fn();
const putJsonMock = vi.fn();

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (path: string) => fetchJsonMock(path),
  postJson: (path: string, body?: unknown) => postJsonMock(path, body),
  putJson: (path: string, body?: unknown) => putJsonMock(path, body),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
  fetchMergedConfig: () => fetchJsonMock('/config/merged'),
  fetchLocalConfig: () => fetchJsonMock('/config/local'),
  writeScopedConfig: (scope: string, patch: Record<string, unknown>) => putJsonMock('/config/scoped', { scope, patch }),
  clearLocalConfigKeys: (keys: string[]) => putJsonMock('/config/scoped', { scope: 'local', patch: {}, clear: keys }),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown) {
      super(`API error ${status}`);
    }
  },
}));

const { default: Okf } = await import('../../packages/myco/ui/src/pages/Okf');

/* ---------- Helpers ---------- */

function routeFetch(path: string): unknown {
  if (path === '/okf/status') return ENABLED_STATUS;
  if (path === '/config/merged') return { okf: { enabled: true } };
  if (path === '/config/local') return {};
  if (path === '/okf/pages') return { ok: true, pages: [] };
  if (path === '/content-claims') {
    return {
      ok: true,
      claimable: claimable.map((c) => ({ ...c, active_claim: activeClaim && activeClaim.artifact_id === c.artifact_id ? activeClaim : null })),
      active_claims: activeClaim ? [activeClaim] : [],
    };
  }
  if (path === '/stats') return { context: { request: { machine_id: 'machine-a' } } };
  return {};
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <PowerProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Okf />
        </MemoryRouter>
      </QueryClientProvider>
    </PowerProvider>,
  );
}

beforeEach(() => {
  claimable = [];
  activeClaim = null;
  fetchJsonMock.mockReset();
  postJsonMock.mockReset();
  putJsonMock.mockReset();
  fetchJsonMock.mockImplementation((path: string) => Promise.resolve(routeFetch(path)));
  postJsonMock.mockImplementation(async (path: string) => {
    if (path === '/content-claims') {
      activeClaim = {
        id: 'cclaim_page1',
        artifact_kind: 'okf_page',
        artifact_id: 'page-1',
        generation: 2,
        claimed_by: 'machine-a',
        claimed_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 86_400,
        state: 'active',
        released_at: null,
        published_at: null,
        stale: false,
      };
      return { ok: true, claim: activeClaim, content: {} };
    }
    if (path === '/content-claims/cclaim_page1/materialize') {
      return { ok: true, path: 'docs/okf/concepts/foo.md', page_path: 'concepts/foo.md', generation: 2 };
    }
    return { ok: true };
  });
});

/* ---------- Tests ---------- */

describe('Okf page — Publish panel (no claimable pages)', () => {
  it('renders no Publish panel when every page is caught up', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('okf-status-chip')).toBeInTheDocument());
    expect(screen.queryByTestId('okf-claims-panel')).toBeNull();
  });
});

describe('Okf page — Publish panel (claimable pages present)', () => {
  beforeEach(() => {
    claimable = [
      {
        artifact_kind: 'okf_page',
        artifact_id: 'page-1',
        label: 'concepts/foo.md',
        lineage_generation: 2,
        published_generation: 1,
        active_claim: null,
      },
    ];
  });

  it('lists the unpublished page with its own Publish control', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('okf-claims-panel')).toBeInTheDocument());
    expect(screen.getByText('concepts/foo.md')).toBeInTheDocument();
    expect(screen.getByTestId('claim-control-okf_page-page-1')).toBeInTheDocument();
    expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument();
  });

  it('Publish on an OKF page claims the page artifact kind, then materializes it', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('claim-and-materialize'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith('/content-claims', { artifact_kind: 'okf_page', artifact_id: 'page-1' });
    });
    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_page1/materialize', { project_root: '/tmp/project-a' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('materialize-success')).toHaveTextContent('docs/okf/concepts/foo.md');
    });
  });
});
