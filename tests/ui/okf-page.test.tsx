// @vitest-environment jsdom

/**
 * OKF page — top-level project-scoped page owning the OKF workflow.
 *
 * Mocks `lib/api` (not data hooks — mirrors tests/ui/embedding-tab-stuck.test.tsx)
 * and `hooks/use-project-selection` (a fixed active selection, mirroring the
 * raw-fetch-stub precedent's approach of keeping only the API boundary as
 * the seam). Covers: disabled-state opt-in switch, enabled+valid metric
 * tiles, stale chip, Maintain button POST + pending-disable, actions
 * disabled while unresolved/erroring, the publish-eligibility acknowledgement
 * re-invoking maintain with `acknowledgePublish: true`, and the enable
 * toggle writing at project scope via ScopedField (POST/PUT body has no
 * `scope: 'local'` — it goes through `/config/scoped` with `scope: 'project'`).
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
  counts: null,
  conceptCount: null,
  stale: false,
  publishAcknowledged: true,
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
  counts: { spores: 10, canopy: 5, concepts: 2, guides: 1 },
  conceptCount: 18,
  stale: false,
  publishAcknowledged: true,
  enabled: true,
  outputPath: 'docs/okf',
  validation: { ok: true, level: 'strict', filesChecked: 18, conceptsChecked: 18 },
  agentsPointer: { present: true, stale: false },
  publishEligibility: { ok: true, findings: [] },
  lastRun: null,
};

const STALE_STATUS: OkfStatusResponse = {
  ...ENABLED_VALID_STATUS,
  stale: true,
};

const BLOCKED_STATUS: OkfStatusResponse = {
  ...ENABLED_VALID_STATUS,
  publishAcknowledged: false,
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
  // routes through these — ScopedField on the OKF page needs them wired
  // even though the tests only assert against putJson directly.
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
    return {};
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Okf />
      </MemoryRouter>
    </QueryClientProvider>,
  );
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
  it('renders an opt-in Switch when OKF is disabled for the project', async () => {
    mockApiForStatus(DISABLED_STATUS);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeInTheDocument();
    });
    expect(screen.getByText(/OKF is disabled for this project/i)).toBeInTheDocument();
    // No action buttons while disabled.
    expect(screen.queryByRole('button', { name: /maintain now/i })).toBeNull();
  });

  it('enable toggle writes at PROJECT scope via ScopedField, not Personal', async () => {
    mockApiForStatus(DISABLED_STATUS);
    renderPage();

    const toggle = await screen.findByRole('switch');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(putJsonSpy).toHaveBeenCalled();
    });
    const [path, body] = putJsonSpy.mock.calls[0] as [string, { scope: string; patch: unknown }];
    expect(path).toBe('/config/scoped');
    expect(body.scope).toBe('project');
    expect(body.patch).toEqual({ okf: { enabled: true } });
  });

  it('reactively reveals the enabled panels after toggling enable — no reload needed', async () => {
    // Stateful mock: the enable write flips okf.enabled so the next merged-config
    // + status fetch reflect the enabled state, exactly as the daemon would.
    let okfEnabled = false;
    fetchJsonImpl = async (path: string) => {
      if (path === '/okf/status') return okfEnabled ? ENABLED_VALID_STATUS : DISABLED_STATUS;
      if (path === '/config/merged') return { okf: { enabled: okfEnabled } };
      if (path === '/config/local') return {};
      return {};
    };
    putJsonImpl = async (_path: string, body?: unknown) => {
      if ((body as { patch?: { okf?: { enabled?: boolean } } })?.patch?.okf?.enabled === true) {
        okfEnabled = true;
      }
      return {};
    };

    renderPage();

    const toggle = await screen.findByRole('switch');
    expect(screen.getByText(/OKF is disabled for this project/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /maintain now/i })).toBeNull();

    fireEvent.click(toggle);

    // The config write invalidates the merged-config query; the page re-derives
    // `enabled` from it and reveals the panels WITHOUT a navigation/reload.
    // (Without the reactive gate the status query's stale `enabled: false` would
    // keep the opt-in panel up until a manual reload — this would time out.)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /maintain now/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(/OKF is disabled for this project/i)).toBeNull();
  });
});

describe('Okf page — enabled + valid', () => {
  it('renders MetricCard tiles for generated-at, concepts, generation, output path', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Generated at')).toBeInTheDocument();
    });
    // "Concepts" also appears as a Sources-panel row label — scope to the
    // MetricCard eyebrow specifically (there are two "Concepts" texts once
    // both panels render, which is expected).
    expect(screen.getAllByText('Concepts').length).toBeGreaterThanOrEqual(1);
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

describe('Okf page — stale state', () => {
  it('renders the Stale chip when status.stale is true', async () => {
    mockApiForStatus(STALE_STATUS);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-status-chip')).toHaveTextContent('Stale');
    });
  });
});

describe('Okf page — Maintain action', () => {
  it('fires POST /okf/maintain and disables the button while pending', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS);
    let resolveLater!: (value: unknown) => void;
    postJsonImpl = () => new Promise((resolve) => { resolveLater = resolve; });

    renderPage();

    const maintainBtn = await screen.findByRole('button', { name: /maintain now/i });
    fireEvent.click(maintainBtn);

    await waitFor(() => {
      expect(postJsonSpy).toHaveBeenCalled();
    });
    const [path] = postJsonSpy.mock.calls[0] as [string, unknown];
    expect(path).toBe('/okf/maintain');

    await waitFor(() => {
      expect((screen.getByRole('button', { name: /maintaining/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    resolveLater({ ok: true, result: {} });
  });
});

describe('Okf page — actions disabled while unresolved/erroring', () => {
  it('does not render enabled-state action buttons while the status query is still loading', () => {
    fetchJsonImpl = () => new Promise(() => {}); // never resolves
    renderPage();

    expect(screen.queryByRole('button', { name: /maintain now/i })).toBeNull();
    expect(screen.getByText(/loading okf status/i)).toBeInTheDocument();
  });

  it('shows an error state and no action buttons when the status query fails', async () => {
    mockApiForStatus('error');
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-status-error')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /maintain now/i })).toBeNull();
  });
});

describe('Okf page — Maintain Now surfaces errors (naive-first-user)', () => {
  it('clicking Maintain Now on a 422 okf_publish_not_acknowledged renders the block + finding count + Acknowledge & publish, and acknowledging re-invokes maintain with acknowledgePublish: true', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS);
    const { ApiError } = await import('../../packages/myco/ui/src/lib/api');
    postJsonImpl = async (_path: string, body?: unknown) => {
      if ((body as { acknowledgePublish?: boolean } | undefined)?.acknowledgePublish) {
        return { ok: true, result: {} };
      }
      throw new ApiError(422, {
        error: { code: 'okf_publish_not_acknowledged', message: 'publish blocked by unacknowledged findings' },
        details: {
          findings: [
            { code: 'secret_like_content', path: 'docs/okf/concepts/foo.md', excerpt: 'sk-abc...' },
            { code: 'secret_like_content', path: 'docs/okf/concepts/bar.md', excerpt: 'sk-def...' },
          ],
        },
      });
    };

    renderPage();

    // Drive it exactly as a naive first-time user would — click the button,
    // don't call the hook/API directly. This is the whole point of the test:
    // the original bug was a 422 the UI silently swallowed on this exact click.
    const maintainBtn = await screen.findByRole('button', { name: /maintain now/i });
    fireEvent.click(maintainBtn);

    await waitFor(() => {
      expect(screen.getByTestId('okf-maintain-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/2 findings need acknowledgement/i)).toBeInTheDocument();

    const ackBtn = screen.getByRole('button', { name: /acknowledge & publish/i });
    fireEvent.click(ackBtn);

    await waitFor(() => {
      expect(postJsonSpy).toHaveBeenCalledTimes(2);
    });
    const [path, body] = postJsonSpy.mock.calls[1] as [string, { acknowledgePublish?: boolean }];
    expect(path).toBe('/okf/maintain');
    expect(body).toEqual({ acknowledgePublish: true });
  });

  it('clicking Maintain Now on a not_implemented failure surfaces it visibly (never silently nothing)', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS);
    const { ApiError } = await import('../../packages/myco/ui/src/lib/api');
    postJsonImpl = async () => {
      throw new ApiError(501, {
        error: { code: 'not_implemented', message: 'OKF document synthesis is not yet implemented (Phase 2)' },
      });
    };

    renderPage();

    const maintainBtn = await screen.findByRole('button', { name: /maintain now/i });
    fireEvent.click(maintainBtn);

    await waitFor(() => {
      expect(screen.getByTestId('okf-maintain-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/not yet implemented/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /acknowledge & publish/i })).toBeNull();
  });

  it('clicking Maintain Now on a 422 okf_validation_failed surfaces a remediation hint naming the failed page', async () => {
    mockApiForStatus(ENABLED_VALID_STATUS);
    const { ApiError } = await import('../../packages/myco/ui/src/lib/api');
    postJsonImpl = async () => {
      throw new ApiError(422, {
        error: { code: 'okf_validation_failed', message: 'generated bundle failed strict validation' },
        details: {
          validation: {
            ok: false,
            level: 'strict',
            filesChecked: 5,
            conceptsChecked: 5,
            issues: [
              {
                level: 'error',
                code: 'missing_required_frontmatter_key',
                path: 'docs/okf/concepts/hand-edited.md',
                message: 'missing required key "title"',
              },
            ],
          },
        },
      });
    };

    renderPage();

    const maintainBtn = await screen.findByRole('button', { name: /maintain now/i });
    fireEvent.click(maintainBtn);

    await waitFor(() => {
      expect(screen.getByTestId('okf-maintain-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/docs\/okf\/concepts\/hand-edited\.md/)).toBeInTheDocument();
    expect(screen.getByText(/fix or remove the hand-edited page, or trigger a full rebuild/i)).toBeInTheDocument();
  });
});

describe('Okf page — publish-eligibility acknowledgement', () => {
  it('renders the blocked publish-eligibility panel and re-invokes maintain with acknowledgePublish: true', async () => {
    mockApiForStatus(BLOCKED_STATUS);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('okf-publish-eligibility-block')).toBeInTheDocument();
    });

    const ackBtn = screen.getByRole('button', { name: /acknowledge/i });
    fireEvent.click(ackBtn);

    await waitFor(() => {
      expect(postJsonSpy).toHaveBeenCalled();
    });
    const [path, body] = postJsonSpy.mock.calls[0] as [string, { acknowledgePublish?: boolean }];
    expect(path).toBe('/okf/maintain');
    expect(body).toEqual({ acknowledgePublish: true });
  });
});
