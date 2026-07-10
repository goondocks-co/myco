// @vitest-environment jsdom

/**
 * OKF page — a focused read surface: conditional publish-block banner (the one
 * human decision), bundle status with "Open in VS Code", the bundle's on-disk
 * directory structure, and an About card linking the OKF spec. The page
 * renders no markdown bodies (the wiki is files; the editor is the browser)
 * and carries no Validate/Copy-path/History/Discovery cards.
 *
 * Mocks `lib/api` (not data hooks — mirrors tests/ui/embedding-tab-stuck.test.tsx)
 * and `hooks/use-project-selection` (a fixed active selection). Covers: the
 * disabled-state banner linking to Settings, the reactive reveal when
 * `okf.enabled` flips on externally, status tiles + chip + editor button, the
 * structure tree (folders, pages, generated index/log rows), the load-time
 * publish-block + Acknowledge → POST /api/okf/acknowledge, the About/spec
 * link + conditional pointer warning, and loading/error states.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { OkfPageSummary, OkfStatusResponse } from '../../packages/myco/ui/src/hooks/use-okf';
import type { ProjectSelection } from '../../packages/myco/ui/src/lib/selection';

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

const DISABLED_STATUS: OkfStatusResponse = {
  outputRoot: '/tmp/project-a/.myco-okf',
  bundleExists: false,
  claimedBundleExists: false,
  bundleGeneration: null,
  inputsHash: null,
  generatedAt: null,
  lastResult: null,
  byType: null,
  pageCount: null,
  publishAcknowledged: true,
  pendingFindings: [],
  enabled: false,
  outputPath: 'docs/okf',
  validation: null,
  agentsPointer: { present: false, stale: false },
  publishEligibility: { ok: true, findings: [] },
  lastRun: null,
};

const ENABLED_VALID_STATUS: OkfStatusResponse = {
  outputRoot: '/tmp/project-a/docs/okf',
  bundleExists: true,
  claimedBundleExists: true,
  bundleGeneration: 3,
  inputsHash: 'abc123',
  generatedAt: '2026-07-01T00:00:00.000Z',
  lastResult: 'published',
  byType: { concept: 17, guide: 1 },
  pageCount: 18,
  publishAcknowledged: true,
  pendingFindings: [],
  enabled: true,
  outputPath: 'docs/okf',
  validation: { ok: true, level: 'strict', filesChecked: 18, conceptsChecked: 18 },
  agentsPointer: { present: true, stale: false },
  publishEligibility: { ok: true, findings: [] },
  lastRun: null,
};

// A PRIOR synthesis run left the bundle blocked from publishing —
// `pendingFindings` is persisted status, not a mutation error, so this must
// be visible on a plain page load with no click.
const BLOCKED_STATUS: OkfStatusResponse = {
  ...ENABLED_VALID_STATUS,
  publishAcknowledged: false,
  pendingFindings: [{ code: 'secret_like_content', path: 'concepts/foo.md' }],
  publishEligibility: {
    ok: false,
    findings: [
      { code: 'secret_like_content', path: 'concepts/foo.md', excerpt: 'sk-abc...' },
    ],
  },
};

const PAGES: OkfPageSummary[] = [
  { path: 'overview.md', type: 'overview', title: 'Myco: Overview' },
  { path: 'architecture/runtime-and-daemon.md', type: 'architecture', title: 'Runtime & Daemon Authority' },
  { path: 'subsystems/canopy.md', type: 'subsystem', title: 'Canopy: Code-Intelligence Pipeline' },
  { path: 'subsystems/team-sync.md', type: 'subsystem', title: 'Team Sync' },
];

/* ---------- Mocks ---------- */

// The Okf page renders OkfClaimsPanel (B6, per-page claim affordances) —
// stub the hook so this pre-existing suite (which predates the claim system
// and doesn't exercise it) doesn't need a PowerProvider just to satisfy
// usePowerQuery's context requirement. Claim-panel behavior has its own
// coverage in tests/ui/okf-claims-panel.test.tsx.
mock.module('../../packages/myco/ui/src/hooks/use-content-claims', () => ({
  useContentClaims: () => ({ data: undefined, isLoading: false }),
  findClaimableArtifact: () => undefined,
  findPublishedArtifact: () => undefined,
  useContentFileStatus: () => ({ data: undefined, isLoading: false, isError: false }),
  useInvalidateContentClaims: () => () => {},
  useMyMachineId: () => undefined,
  useReleaseContentClaim: () => ({ mutate: () => {}, isPending: false }),
  useMarkContentClaimPublished: () => ({ mutate: () => {}, isPending: false }),
  useClaimAndMaterialize: () => ({
    phase: { status: 'idle' },
    run: () => {},
    retryMaterialize: () => {},
    reset: () => {},
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useActiveProjectSelection: () => SELECTION,
  useProjectSelection: () => SELECTION,
  useProjectPath: (suffix = '') => `/g/work/p/project-a-123abc${suffix}`,
  useProjectPathBuilder: () => (suffix = '') => `/g/work/p/project-a-123abc${suffix}`,
  useProjectScopedQueryKey: (key: unknown[]) => [...key, { projectSelection: 'grove-a:project-a' }],
}));

let fetchJsonImpl: (path: string) => Promise<unknown> = async () => ({});
const fetchJsonSpy = vi.fn((path: string) => fetchJsonImpl(path));
let postJsonImpl: (path: string, body?: unknown) => Promise<unknown> = async () => ({ ok: true, result: {} });
const postJsonSpy = vi.fn((path: string, body?: unknown) => postJsonImpl(path, body));
let putJsonImpl: (path: string, body?: unknown) => Promise<unknown> = async () => ({});
const putJsonSpy = vi.fn((path: string, body?: unknown) => putJsonImpl(path, body));

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (path: string) => fetchJsonSpy(path),
  postJson: (path: string, body?: unknown) => postJsonSpy(path, body),
  putJson: (path: string, body?: unknown) => putJsonSpy(path, body),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
  // Scoped-config plumbing (useScopedConfig -> useScopedConfigForSelection)
  // routes through these — the page reads `okf.enabled` off the merged
  // config (writes live on Settings; see settings-okf.test.tsx).
  fetchMergedConfig: () => fetchJsonSpy('/config/merged'),
  fetchLocalConfig: () => fetchJsonSpy('/config/local'),
  writeScopedConfig: (scope: string, patch: Record<string, unknown>, clear?: string[]) =>
    putJsonSpy('/config/scoped', clear && clear.length > 0 ? { scope, patch, clear } : { scope, patch }),
  clearLocalConfigKeys: (keys: string[]) => putJsonSpy('/config/scoped', { scope: 'local', patch: {}, clear: keys }),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown) {
      super(`API error ${status}`);
    }
  },
}));

const { default: Okf } = await import('../../packages/myco/ui/src/pages/Okf');

/* ---------- Helpers ---------- */

function mockApiForStatus(status: OkfStatusResponse | 'error', pages: OkfPageSummary[] = []) {
  fetchJsonImpl = async (path: string) => {
    if (path === '/okf/status') {
      if (status === 'error') throw new Error('boom');
      return status;
    }
    if (path === '/config/merged') return { okf: { enabled: status !== 'error' && status.enabled } };
    if (path === '/config/local') return {};
    if (path === '/okf/pages') return { ok: true, pages };
    return {};
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Okf />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

/* ---------- Tests ---------- */

beforeEach(() => {
  fetchJsonSpy.mockClear();
  postJsonSpy.mockClear();
  putJsonSpy.mockClear();
  postJsonImpl = async () => ({ ok: true, result: {} });
  putJsonImpl = async () => ({});
});

describe('Okf page — disabled state', () => {
  it('renders a disabled banner linking to Settings, with no enable switch and no status panel', async () => {
    mockApiForStatus(DISABLED_STATUS);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/OKF is disabled for this project/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('switch')).toBeNull();
    const settingsLink = screen.getByRole('link', { name: /settings/i });
    expect(settingsLink.getAttribute('href')).toBe('/settings#okf');
    expect(screen.queryByTestId('okf-status-chip')).toBeNull();
  });

  it('reactively reveals the page when okf.enabled flips on externally (e.g. from Settings) — no reload needed', async () => {
    let okfEnabled = false;
    fetchJsonImpl = async (path: string) => {
      if (path === '/okf/status') return okfEnabled ? ENABLED_VALID_STATUS : DISABLED_STATUS;
      if (path === '/config/merged') return { okf: { enabled: okfEnabled } };
      if (path === '/config/local') return {};
      if (path === '/okf/pages') return { ok: true, pages: [] };
      return {};
    };

    const { qc } = renderPage();

    await waitFor(() => {
      expect(screen.getByText(/OKF is disabled for this project/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('okf-status-chip')).toBeNull();

    okfEnabled = true;
    await qc.invalidateQueries({ queryKey: ['config', 'merged'] });

    await waitFor(() => {
      expect(screen.getByTestId('okf-status-chip')).toBeInTheDocument();
    });
    expect(screen.queryByText(/OKF is disabled for this project/i)).toBeNull();
  });
});

describe('Okf page — status', () => {
  it('renders the Valid chip, Generated/Pages/Generation tiles, and the Open in VS Code action', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS, PAGES);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-status-chip')).toHaveTextContent('Valid');
    });
    expect(screen.getByText('Generated')).toBeInTheDocument();
    expect(screen.getByText('Pages')).toBeInTheDocument();
    expect(screen.getByText('Generation')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByTestId('okf-open-in-editor')).toBeInTheDocument();
  });

  it('hides Open in VS Code when no claimed on-disk bundle exists (DB-only wiki)', async () => {
    mockApiForStatus({ ...ENABLED_VALID_STATUS, claimedBundleExists: false }, PAGES);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-status-chip')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('okf-open-in-editor')).toBeNull();
  });

  it('renders the capability indicator ("OKF on") deep-linking to the Groves capability panel', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS, PAGES);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('capability-indicator-okf')).toBeInTheDocument();
    });
    const indicator = screen.getByTestId('capability-indicator-okf');
    expect(indicator).toHaveTextContent('OKF on');
    expect(indicator.getAttribute('href')).toBe('/groves?capabilities=project-a');
  });

  it('shows "OKF off" on the indicator when the capability is disabled', async () => {
    mockApiForStatus(DISABLED_STATUS);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('capability-indicator-okf')).toHaveTextContent('OKF off');
    });
  });

  it('carries none of the retired cards: Validate, Copy path, History, Discovery', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS, PAGES);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-status-chip')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^validate$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /copy path/i })).toBeNull();
    expect(screen.queryByText(/recent maintenance/i)).toBeNull();
    expect(screen.queryByText(/agents\.md pointer/i)).toBeNull();
  });
});

describe('Okf page — structure tree', () => {
  it('renders root pages, folders with their pages, and the generated index/log rows', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS, PAGES);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-structure')).toBeInTheDocument();
    });
    // Root page with its title alongside.
    expect(screen.getByText('overview.md')).toBeInTheDocument();
    expect(screen.getByText('Myco: Overview')).toBeInTheDocument();
    // Folders and their pages.
    expect(screen.getByText('architecture/')).toBeInTheDocument();
    expect(screen.getByText('runtime-and-daemon.md')).toBeInTheDocument();
    expect(screen.getByText('subsystems/')).toBeInTheDocument();
    expect(screen.getByText('canopy.md')).toBeInTheDocument();
    expect(screen.getByText('team-sync.md')).toBeInTheDocument();
    // Generated files: root index.md + log.md, one index.md per folder.
    expect(screen.getAllByText('index.md').length).toBe(3);
    expect(screen.getByText('log.md')).toBeInTheDocument();
    // No markdown bodies rendered.
    expect(screen.queryByText(/how canopy turns raw files/i)).toBeNull();
  });
});

describe('Okf page — load-time publish-block', () => {
  it('renders the blocked-publish banner + finding list + Acknowledge on a plain load — no click needed', async () => {
    mockApiForStatus(BLOCKED_STATUS, PAGES);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-publish-eligibility-block')).toBeInTheDocument();
    });
    expect(screen.getByText(/1 finding need review/i)).toBeInTheDocument();
    expect(screen.getByText(/secret_like_content · concepts\/foo\.md/i)).toBeInTheDocument();
    expect(postJsonSpy).not.toHaveBeenCalled();
  });

  it('clicking Acknowledge & publish posts to /api/okf/acknowledge and the block clears on the refreshed status', async () => {
    let acknowledged = false;
    fetchJsonImpl = async (path: string) => {
      if (path === '/okf/status') return acknowledged ? ENABLED_VALID_STATUS : BLOCKED_STATUS;
      if (path === '/config/merged') return { okf: { enabled: true } };
      if (path === '/config/local') return {};
      if (path === '/okf/pages') return { ok: true, pages: [] };
      return {};
    };
    postJsonImpl = async (path: string) => {
      if (path === '/okf/acknowledge') {
        acknowledged = true;
        return { ok: true, published: true, generation: 3, pageCount: 1 };
      }
      return { ok: true, result: {} };
    };

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-publish-eligibility-block')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /acknowledge & publish/i }));

    await waitFor(() => {
      expect(postJsonSpy).toHaveBeenCalledWith('/okf/acknowledge', {});
    });
    await waitFor(() => {
      expect(screen.queryByTestId('okf-publish-eligibility-block')).toBeNull();
    });
  });
});

describe('Okf page — about card', () => {
  it('links to the OKF spec and shows no pointer warning when the AGENTS.md pointer is healthy', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS, PAGES);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /open knowledge format/i })).toBeInTheDocument();
    });
    const specLink = screen.getByRole('link', { name: /open knowledge format/i });
    expect(specLink.getAttribute('href')).toContain('GoogleCloudPlatform/knowledge-catalog');
    expect(screen.queryByTestId('okf-pointer-warning')).toBeNull();
  });

  it('surfaces a pointer warning only when the AGENTS.md pointer is missing', async () => {
    mockApiForStatus({ ...ENABLED_VALID_STATUS, agentsPointer: { present: false, stale: false } }, PAGES);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-pointer-warning')).toBeInTheDocument();
    });
    expect(screen.getByTestId('okf-pointer-warning')).toHaveTextContent(/missing/i);
  });
});

describe('Okf page — loading/error states', () => {
  it('renders only the loading surface while the status query is in flight', () => {
    fetchJsonImpl = () => new Promise(() => {}); // never resolves
    renderPage();

    expect(screen.getByText(/loading okf status/i)).toBeInTheDocument();
    expect(screen.queryByTestId('okf-status-chip')).toBeNull();
  });

  it('shows an error state when the status query fails', async () => {
    mockApiForStatus('error');
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-status-error')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('okf-status-chip')).toBeNull();
  });
});
