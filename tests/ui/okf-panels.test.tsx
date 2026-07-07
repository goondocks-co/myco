// @vitest-environment jsdom

/**
 * OKF panel components — OkfStatusPanel, OkfActionsPanel, OkfDiscoveryPanel.
 * These are pure/presentational (props in, no data hooks besides the
 * mutation objects passed by the caller), so they render directly without
 * mocking `lib/api`.
 *
 * OkfSourcesPanel and OkfValidationPanel were deleted in Task 5.2 — the
 * browser (OkfBrowser, Task 5.1) already groups pages by type, and the
 * validation/publish-block surface duplicated OkfActionsPanel's maintain-error
 * surface (Task 4.1); the Maintenance strip on the OKF page is now the single
 * publish-block surface.
 *
 * Covers: component-consistency — panels use Panel/Surface/MetricCard/
 * Button/Switch primitives, asserted via their stable class/testid
 * conventions (mirrors tests/ui/metric-card.test.tsx).
 */

import { describe, expect, it, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { OkfStatusResponse } from '../../packages/myco/ui/src/hooks/use-okf';

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: async () => ({}),
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

const { OkfStatusPanel } = await import('../../packages/myco/ui/src/components/okf/OkfStatusPanel');
const { OkfActionsPanel } = await import('../../packages/myco/ui/src/components/okf/OkfActionsPanel');
const { OkfDiscoveryPanel } = await import('../../packages/myco/ui/src/components/okf/OkfDiscoveryPanel');

const BASE_STATUS: OkfStatusResponse = {
  outputRoot: '/tmp/project-a/docs/okf',
  bundleExists: true,
  bundleGeneration: 3,
  inputsHash: 'abc123',
  generatedAt: '2026-07-01T00:00:00.000Z',
  lastResult: 'published',
  byType: { decision: 10, file: 5, guide: 1 },
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

function wrap(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

/* ---------- Fake mutation objects (mirror useMutation result shape) ---------- */

function fakeMutation(overrides: Partial<{ isPending: boolean; mutate: (v?: unknown) => void }> = {}) {
  return {
    mutate: overrides.mutate ?? (() => {}),
    isPending: overrides.isPending ?? false,
  } as any;
}

describe('OkfStatusPanel', () => {
  it('renders MetricCard tiles using the MetricCard primitive (component-consistency)', () => {
    wrap(<OkfStatusPanel status={BASE_STATUS} />);
    expect(screen.getByText('Generated at')).toBeInTheDocument();
    expect(screen.getByText('Pages')).toBeInTheDocument();
    expect(screen.getByText('Generation')).toBeInTheDocument();
    expect(screen.getByText('Output path')).toBeInTheDocument();
    // MetricCard's eyebrow uses this stable class (metric-card.test.tsx pins it).
    const eyebrow = screen.getByText('Generated at');
    expect(eyebrow.className).toContain('myco-eyebrow');
  });

  it('renders a Valid status chip when the bundle is not stale/failed/invalid', () => {
    wrap(<OkfStatusPanel status={BASE_STATUS} />);
    expect(screen.getByTestId('okf-status-chip')).toHaveTextContent('Valid');
  });

  it('renders a Stale chip when status.stale is true', () => {
    wrap(<OkfStatusPanel status={{ ...BASE_STATUS, stale: true }} />);
    expect(screen.getByTestId('okf-status-chip')).toHaveTextContent('Stale');
  });

  it('renders a Not generated chip when the bundle does not exist', () => {
    wrap(<OkfStatusPanel status={{ ...BASE_STATUS, bundleExists: false }} />);
    expect(screen.getByTestId('okf-status-chip')).toHaveTextContent('Not generated');
  });
});

describe('OkfActionsPanel — component-consistency + disabled states', () => {
  it('renders Maintain/Validate/Copy as Button primitives', () => {
    wrap(
      <OkfActionsPanel status={BASE_STATUS} maintain={fakeMutation()} validate={fakeMutation()} />,
    );
    const maintainBtn = screen.getByRole('button', { name: /maintain now/i });
    expect(maintainBtn.tagName).toBe('BUTTON');
    expect(screen.getByRole('button', { name: /validate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy path/i })).toBeInTheDocument();
  });

  it('disables all actions when OKF is disabled', () => {
    wrap(
      <OkfActionsPanel
        status={{ ...BASE_STATUS, enabled: false }}
        maintain={fakeMutation()}
        validate={fakeMutation()}
      />,
    );
    expect((screen.getByRole('button', { name: /maintain now/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /validate/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /copy path/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('OkfActionsPanel — load-time publish-block (persisted status, no maintain click)', () => {
  it('renders the block from status.publishEligibility alone when there is no mutation error', () => {
    const status = {
      ...BASE_STATUS,
      publishEligibility: {
        ok: false,
        findings: [{ code: 'secret_like_content', path: 'a.md', excerpt: 'x' }],
      },
    };
    wrap(<OkfActionsPanel status={status} maintain={fakeMutation()} validate={fakeMutation()} />);
    expect(screen.getByTestId('okf-publish-eligibility-block')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /acknowledge & publish/i })).toBeInTheDocument();
  });

  it('does not render the load-time block when publishEligibility.ok is true', () => {
    wrap(<OkfActionsPanel status={BASE_STATUS} maintain={fakeMutation()} validate={fakeMutation()} />);
    expect(screen.queryByTestId('okf-publish-eligibility-block')).toBeNull();
  });

  it('defers to the click-driven maintain-error block instead of double-rendering when both are present', () => {
    const status = {
      ...BASE_STATUS,
      publishEligibility: {
        ok: false,
        findings: [{ code: 'secret_like_content', path: 'a.md', excerpt: 'x' }],
      },
    };
    const maintainError = {
      message: 'boom',
      body: {
        error: { code: 'not_implemented', message: 'boom' },
      },
    };
    wrap(
      <OkfActionsPanel
        status={status}
        maintain={{ mutate: () => {}, isPending: false, error: maintainError } as any}
        validate={fakeMutation()}
      />,
    );
    expect(screen.getByTestId('okf-maintain-error')).toBeInTheDocument();
    expect(screen.queryByTestId('okf-publish-eligibility-block')).toBeNull();
  });
});

describe('OkfDiscoveryPanel', () => {
  it('renders Present when the AGENTS.md pointer is present and fresh', () => {
    wrap(<OkfDiscoveryPanel status={BASE_STATUS} />);
    expect(screen.getByText('Present')).toBeInTheDocument();
  });

  it('renders Missing when the pointer is absent', () => {
    wrap(<OkfDiscoveryPanel status={{ ...BASE_STATUS, agentsPointer: { present: false, stale: false } }} />);
    expect(screen.getByText('Missing')).toBeInTheDocument();
  });

  it('renders Stale when the pointer is present but stale', () => {
    wrap(<OkfDiscoveryPanel status={{ ...BASE_STATUS, agentsPointer: { present: true, stale: true } }} />);
    expect(screen.getByText('Stale')).toBeInTheDocument();
  });

  it('links to /symbionts for per-symbiont readiness', () => {
    wrap(<OkfDiscoveryPanel status={BASE_STATUS} />);
    const link = screen.getByRole('link', { name: /symbionts/i });
    expect(link.getAttribute('href')).toBe('/symbionts');
  });
});
