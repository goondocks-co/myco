// @vitest-environment jsdom

/**
 * OKF knowledge browser — list + rendered-markdown detail (Task 5.1).
 *
 * Mocks `lib/api` (mirrors tests/ui/canopy-entries-list.test.tsx and
 * tests/ui/okf-page.test.tsx) rather than the data hooks — keeping the API
 * boundary as the only seam. Covers: pages grouped by type/section with
 * titles + descriptions rendered; clicking a page row (as a naive user
 * would — `fireEvent.click`, not a direct hook call) loads its rendered
 * markdown into the detail view; clicking an in-body bundle-relative link
 * navigates the detail view to the linked page instead of following a
 * broken href.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { OkfPageDetail, OkfPageSummary } from '../../packages/myco/ui/src/hooks/use-okf';

/* ---------- Fixtures ---------- */

const PAGES: OkfPageSummary[] = [
  {
    path: 'concepts/auth.md',
    type: 'concept',
    title: 'Authentication',
    description: 'How auth works.',
    timestamp: '2026-07-01T00:00:00.000Z',
  },
  {
    path: 'concepts/billing.md',
    type: 'concept',
    title: 'Billing',
    description: 'How billing works.',
    timestamp: '2026-07-02T00:00:00.000Z',
  },
  {
    path: 'guides/getting-started.md',
    type: 'guide',
    title: 'Getting Started',
    description: 'Onboarding steps.',
    timestamp: '2026-06-01T00:00:00.000Z',
  },
];

const PAGE_DETAILS: Record<string, OkfPageDetail> = {
  'concepts/auth.md': {
    path: 'concepts/auth.md',
    type: 'concept',
    title: 'Authentication',
    description: 'How auth works.',
    timestamp: '2026-07-01T00:00:00.000Z',
    body: 'Auth body content. See [Billing](/concepts/billing.md) for pricing.',
  },
  'concepts/billing.md': {
    path: 'concepts/billing.md',
    type: 'concept',
    title: 'Billing',
    description: 'How billing works.',
    timestamp: '2026-07-02T00:00:00.000Z',
    body: 'Billing body content.',
  },
  'guides/getting-started.md': {
    path: 'guides/getting-started.md',
    type: 'guide',
    title: 'Getting Started',
    description: 'Onboarding steps.',
    timestamp: '2026-06-01T00:00:00.000Z',
    body: 'Getting-started body content.',
  },
};

/* ---------- Mocks ---------- */

const fetchJsonMock = vi.fn();

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  postJson: vi.fn(),
  putJson: vi.fn(),
  patchJson: vi.fn(),
  deleteJson: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown) {
      super(`API error ${status}`);
    }
  },
}));

const PAGES_PREFIX = '/okf/pages/';

function mockApi() {
  fetchJsonMock.mockImplementation((path: string) => {
    if (path === '/okf/pages') {
      return Promise.resolve({ ok: true, pages: PAGES });
    }
    if (path.startsWith(PAGES_PREFIX)) {
      const pagePath = decodeURIComponent(path.slice(PAGES_PREFIX.length));
      return Promise.resolve({ ok: true, page: PAGE_DETAILS[pagePath] ?? null });
    }
    return Promise.resolve({});
  });
}

// Imported AFTER the mock so the module-level fetchJson resolves to the stub.
const { OkfBrowser } = await import('../../packages/myco/ui/src/components/okf/OkfBrowser');

/* ---------- Helpers ---------- */

function renderBrowser() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OkfBrowser />
    </QueryClientProvider>,
  );
}

/* ---------- Tests ---------- */

beforeEach(() => {
  fetchJsonMock.mockReset();
});

describe('OkfBrowser — list grouped by section/type', () => {
  it('renders sections with page titles and descriptions', async () => {
    mockApi();
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText('Authentication')).toBeInTheDocument();
    });

    // Two type groups: "concept" (2 pages) and "guide" (1 page).
    expect(screen.getByText('concept')).toBeInTheDocument();
    expect(screen.getByText('guide')).toBeInTheDocument();

    expect(screen.getByText('Billing')).toBeInTheDocument();
    expect(screen.getByText('Getting Started')).toBeInTheDocument();

    expect(screen.getByText('How auth works.')).toBeInTheDocument();
    expect(screen.getByText('How billing works.')).toBeInTheDocument();
    expect(screen.getByText('Onboarding steps.')).toBeInTheDocument();
  });
});

describe('OkfBrowser — selecting a page', () => {
  it('clicking a page row loads its rendered markdown into the detail view', async () => {
    mockApi();
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText('Authentication')).toBeInTheDocument();
    });

    // Drive it as a naive first-time user would — click the row, don't call
    // useOkfDocument directly.
    fireEvent.click(screen.getByTestId('okf-page-row-concepts/auth.md'));

    await waitFor(() => {
      expect(screen.getByTestId('okf-page-detail')).toBeInTheDocument();
    });
    expect(screen.getByText(/Auth body content/)).toBeInTheDocument();
  });

  it('clicking an in-body bundle-relative link navigates the detail view to the linked page', async () => {
    mockApi();
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText('Authentication')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('okf-page-row-concepts/auth.md'));

    await waitFor(() => {
      expect(screen.getByText(/Auth body content/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('link', { name: 'Billing' }));

    await waitFor(() => {
      expect(screen.getByText('Billing body content.')).toBeInTheDocument();
    });
  });
});
