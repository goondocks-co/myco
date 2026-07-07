// @vitest-environment jsdom

/**
 * OKF page — top-level project-scoped page owning the OKF workflow.
 *
 * Knowledge-first shape (Task 5.2): the primary content is the OkfBrowser
 * knowledge browser; a Maintenance strip below it (status + Validate action +
 * the publish-block + recent history) is secondary. Config (enable,
 * synthesis scope, output path, AGENTS.md pointer) moved to Settings — this
 * page no longer renders an enable Switch or an Advanced options slideout,
 * and the standalone Sources/Validation cards were deleted (their content is
 * either subsumed by the browser (Sources) or folded into the Maintenance
 * strip via OkfActionsPanel's publish-block surface (Validation) — see
 * Task 4.1).
 *
 * Task 7.3 retired "Maintain Now" — maintenance is now the async
 * `okf-synthesize` scheduled task, not a UI-triggered mutation. The
 * publish-block is purely status-driven: a blocked synthesis run persists
 * `pendingFindings`, which `handleOkfStatus` folds into
 * `publishEligibility`, and "Acknowledge & publish" calls `useOkfAcknowledge`
 * (`POST /api/okf/acknowledge`) instead of re-invoking a maintain mutation.
 *
 * Mocks `lib/api` (not data hooks — mirrors tests/ui/embedding-tab-stuck.test.tsx)
 * and `hooks/use-project-selection` (a fixed active selection, mirroring the
 * raw-fetch-stub precedent's approach of keeping only the API boundary as
 * the seam). Covers: disabled-state banner linking to Settings, enabled+valid
 * metric tiles, actions disabled while unresolved/erroring, the
 * naive-first-user load-time publish-block surface + Acknowledge → POST
 * /api/okf/acknowledge, and the reactive reveal of the page when
 * `okf.enabled` flips on externally (e.g. from Settings) without a
 * navigation/reload.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { OkfStatusResponse } from '../../packages/myco/ui/src/hooks/use-okf';
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
// `pendingFindings` is persisted status (Task 7.1), not a mutation error, so
// this must be visible on a plain page load with no click.
const BLOCKED_STATUS: OkfStatusResponse = {
  ...ENABLED_VALID_STATUS,
  publishAcknowledged: false,
  pendingFindings: [{ code: 'secret_like_content', path: 'docs/okf/concepts/foo.md' }],
  publishEligibility: {
    ok: false,
    findings: [
      { code: 'secret_like_content', path: 'docs/okf/concepts/foo.md', excerpt: 'sk-abc...' },
    ],
  },
};

/* ---------- Mocks ---------- */

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
  // config even though it no longer writes it directly (that moved to
  // Settings; see settings-okf.test.tsx).
  fetchMergedConfig: (signal?: AbortSignal, headers?: HeadersInit) => fetchJsonSpy('/config/merged'),
  fetchLocalConfig: (signal?: AbortSignal, headers?: HeadersInit) => fetchJsonSpy('/config/local'),
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

function mockApiForStatus(status: OkfStatusResponse | 'error') {
  fetchJsonImpl = async (path: string) => {
    if (path === '/okf/status') {
      if (status === 'error') throw new Error('boom');
      return status;
    }
    if (path === '/config/merged') return { okf: { enabled: status !== 'error' && status.enabled } };
    if (path === '/config/local') return {};
    if (path === '/okf/pages') return { ok: true, pages: [] };
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
  it('renders a disabled banner linking to Settings, with no enable switch and no action buttons', async () => {
    mockApiForStatus(DISABLED_STATUS);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/OKF is disabled for this project/i)).toBeInTheDocument();
    });
    // Config (including enable) lives on Settings now — the page links there
    // rather than embedding a Switch.
    expect(screen.queryByRole('switch')).toBeNull();
    const settingsLink = screen.getByRole('link', { name: /settings/i });
    expect(settingsLink.getAttribute('href')).toBe('/settings#okf');
    expect(screen.queryByRole('button', { name: /validate/i })).toBeNull();
  });

  it('reactively reveals the browser + Maintenance strip when okf.enabled flips on externally (e.g. from Settings) — no reload needed', async () => {
    // Stateful mock: an external write (Settings) flips okf.enabled so the
    // next merged-config + status fetch reflect the enabled state, exactly
    // as the daemon would report it.
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
    expect(screen.queryByRole('button', { name: /validate/i })).toBeNull();

    // Simulate the external config write (Settings) and invalidate the
    // merged-config query the same way a real write would.
    okfEnabled = true;
    await qc.invalidateQueries({ queryKey: ['config', 'merged'] });

    // The page re-derives `enabled` from the merged config and reveals the
    // panels WITHOUT a navigation/reload. (Without the reactive gate the
    // status query's stale `enabled: false` would keep the opt-in banner up
    // until a manual reload — this would time out.)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /validate/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(/OKF is disabled for this project/i)).toBeNull();
  });
});

describe('Okf page — knowledge-first shape (Task 5.2)', () => {
  it('renders the browser + Maintenance strip, and no standalone Sources or Validation card', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /validate/i })).toBeInTheDocument();
    });
    // Browser present (Knowledge panel wraps OkfBrowser).
    expect(screen.getByText('Knowledge')).toBeInTheDocument();
    // Maintenance strip present.
    expect(screen.getByText('Maintenance')).toBeInTheDocument();
    expect(screen.getByText('Recent maintenance')).toBeInTheDocument();
    // The deleted panels' titles never appear.
    expect(screen.queryByText(/pages by type/i)).toBeNull();
    expect(screen.queryByText(/validation & publish/i)).toBeNull();
  });
});

describe('Okf page — load-time publish-block (persisted status, synthesis-world)', () => {
  it('renders the blocked-publish banner + finding count + Acknowledge on a plain load — no click needed', async () => {
    mockApiForStatus(BLOCKED_STATUS);
    renderPage();

    // No click here — this is the persisted-state case (Task 7.1): a PRIOR
    // synthesis run left the bundle blocked (status.pendingFindings
    // non-empty), so the banner must appear from `status` alone.
    await waitFor(() => {
      expect(screen.getByTestId('okf-publish-eligibility-block')).toBeInTheDocument();
    });
    expect(screen.getByText(/1 finding need acknowledgement/i)).toBeInTheDocument();
    expect(postJsonSpy).not.toHaveBeenCalled();
  });

  it('clicking Acknowledge & publish posts to /api/okf/acknowledge and the block clears on the refreshed status', async () => {
    // Stateful mock: acknowledging flips the next /okf/status fetch to the
    // unblocked status, exactly as the daemon would report it once
    // `pending_findings` is drained.
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
        return { ok: true, status: {} };
      }
      return { ok: true, result: {} };
    };

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-publish-eligibility-block')).toBeInTheDocument();
    });

    const ackBtn = screen.getByRole('button', { name: /acknowledge & publish/i });
    fireEvent.click(ackBtn);

    await waitFor(() => {
      expect(postJsonSpy).toHaveBeenCalledWith('/okf/acknowledge', {});
    });
    await waitFor(() => {
      expect(screen.queryByTestId('okf-publish-eligibility-block')).toBeNull();
    });
  });
});

describe('Okf page — enabled + valid', () => {
  it('renders MetricCard tiles for generated-at, pages, generation, output path', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Generated at')).toBeInTheDocument();
    });
    expect(screen.getByText('Pages')).toBeInTheDocument();
    expect(screen.getByText('Generation')).toBeInTheDocument();
    expect(screen.getByText('Output path')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders the Valid status chip', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-status-chip')).toHaveTextContent('Valid');
    });
  });
});

describe('Okf page — Validate action', () => {
  it('fires POST /okf/validate and disables the button while pending', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS);
    let resolveLater!: (value: unknown) => void;
    postJsonImpl = () => new Promise((resolve) => { resolveLater = resolve; });

    renderPage();

    const validateBtn = await screen.findByRole('button', { name: /validate/i });
    fireEvent.click(validateBtn);

    await waitFor(() => {
      expect(postJsonSpy).toHaveBeenCalled();
    });
    const [path] = postJsonSpy.mock.calls[0] as [string, unknown];
    expect(path).toBe('/okf/validate');

    await waitFor(() => {
      expect((screen.getByRole('button', { name: /validating/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    resolveLater({ ok: true, validation: { ok: true, level: 'strict', filesChecked: 18, conceptsChecked: 18 } });
  });
});

describe('Okf page — actions disabled while unresolved/erroring', () => {
  it('does not render enabled-state action buttons while the status query is still loading', () => {
    fetchJsonImpl = () => new Promise(() => {}); // never resolves
    renderPage();

    expect(screen.queryByRole('button', { name: /validate/i })).toBeNull();
    expect(screen.getByText(/loading okf status/i)).toBeInTheDocument();
  });

  it('shows an error state and no action buttons when the status query fails', async () => {
    mockApiForStatus('error');
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-status-error')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /validate/i })).toBeNull();
  });
});
