// @vitest-environment jsdom

/**
 * OkfReadinessPanel — read-only OKF readiness section on the Symbionts page.
 *
 * Covers: readiness rows render for the active project; links to /okf;
 * asserts ABSENCE of any Maintain-Now button or output-path input (those
 * are OKF-page-only actions); the no-project unavailable state.
 */

import { describe, expect, it, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { OkfStatusResponse } from '../../packages/myco/ui/src/hooks/use-okf';
import type { ProjectSelection } from '../../packages/myco/ui/src/lib/selection';
import type { SymbiontInfo } from '../../packages/myco/ui/src/hooks/use-symbionts';

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

const SYMBIONTS: SymbiontInfo[] = [
  {
    name: 'claude-code',
    displayName: 'Claude Code',
    binary: 'claude',
    enabled: true,
    detected: true,
    globallyInstalled: true,
    supportsSessionStartInjection: true,
    supportsPromptSubmitInjection: true,
    supportsSessions: true,
    supportsCanopyInjection: true,
    supportsSubagentStartInjection: true,
    supportsPlanCapture: true,
    supportsSkills: true,
    supportsMcp: true,
    mcpActive: true,
  },
  {
    name: 'cursor',
    displayName: 'Cursor',
    binary: 'cursor',
    enabled: true,
    detected: true,
    globallyInstalled: true,
    supportsSessionStartInjection: false,
    supportsPromptSubmitInjection: false,
    supportsSessions: true,
    supportsCanopyInjection: false,
    supportsSubagentStartInjection: false,
    supportsPlanCapture: false,
    supportsSkills: false,
    supportsMcp: false,
  },
];

let activeSelection: ProjectSelection | null = SELECTION;

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useActiveProjectSelection: () => activeSelection,
  useProjectSelection: () => activeSelection,
  useProjectPath: (suffix = '') => suffix,
  useProjectPathBuilder: () => (suffix = '') => suffix,
  useProjectScopedQueryKey: (key: unknown[]) => key,
}));

// Capture the last `/okf/status` request so a test can assert the panel passes
// EXPLICIT project-context headers. The Symbionts page renders under the
// machine-scoped boundary, which leaves the module-level request selection null;
// if useOkfStatusForSelection ever dropped its explicit `headers`, the request
// would 400 in production but still pass a header-blind mock. This closes that gap.
let lastStatusInit: RequestInit | undefined;

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: async (path: string, init?: RequestInit) => {
    if (path === '/okf/status') {
      lastStatusInit = init;
      return ENABLED_STATUS;
    }
    return {};
  },
  postJson: async () => ({}),
  putJson: async () => ({}),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown) {
      super(`API error ${status}`);
    }
  },
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { OkfReadinessPanel } = await import(
  '../../packages/myco/ui/src/components/symbionts/OkfReadinessPanel'
);

function renderPanel(symbionts: SymbiontInfo[] = SYMBIONTS) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OkfReadinessPanel symbionts={symbionts} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OkfReadinessPanel', () => {
  it('renders readiness rows for the active project', async () => {
    activeSelection = SELECTION;
    renderPanel();

    expect(await screen.findByTestId('okf-readiness-panel')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Cursor')).toBeInTheDocument();
    expect(screen.getByText('OKF tools')).toBeInTheDocument();
    expect(screen.getByText('CLI fallback')).toBeInTheDocument();
  });

  it('links to /okf for management', async () => {
    activeSelection = SELECTION;
    renderPanel();

    const link = await screen.findByRole('link', { name: /manage okf/i });
    expect(link.getAttribute('href')).toBe('/okf');
  });

  it('does NOT render a Maintain-Now button or output-path input', async () => {
    activeSelection = SELECTION;
    renderPanel();

    await screen.findByTestId('okf-readiness-panel');
    expect(screen.queryByRole('button', { name: /maintain now/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByDisplayValue('docs/okf')).toBeNull();
  });

  it('renders the unavailable state when no project is selected', () => {
    activeSelection = null;
    renderPanel();

    expect(screen.getByTestId('okf-readiness-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('okf-readiness-panel')).toBeNull();
  });

  it('fetches status with explicit project-context headers (machine-scoped route)', async () => {
    activeSelection = SELECTION;
    lastStatusInit = undefined;
    renderPanel();

    await waitFor(() => expect(lastStatusInit).toBeDefined());
    const headers = lastStatusInit?.headers as Record<string, string> | undefined;
    expect(headers?.['x-myco-grove-id']).toBe(SELECTION.grove.id);
    expect(headers?.['x-myco-project-id']).toBe(SELECTION.project.project_id);
  });
});
