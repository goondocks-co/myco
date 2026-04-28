// @vitest-environment jsdom

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import * as ReactRouterDom from 'react-router-dom';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from '../helpers/vi-shim.js';

/* ---------- jsdom polyfills ---------- */

// The shared jsdom setup (tests/setup/jsdom.ts) doesn't expose
// MutationObserver / ResizeObserver, but Radix's focus-scope (used by
// Dialog) depends on them. Other UI tests work around this by never
// opening a Dialog; we have to. Inject minimal stubs sufficient for the
// component to mount without throwing.
class MutationObserverStub {
  observe(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] { return []; }
}
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const _g = globalThis as unknown as Record<string, unknown>;
if (typeof _g.MutationObserver === 'undefined') _g.MutationObserver = MutationObserverStub;
if (typeof _g.ResizeObserver === 'undefined') _g.ResizeObserver = ResizeObserverStub;
// Radix's focus-scope walks the DOM with a TreeWalker filtered by NodeFilter
// constants. jsdom defines them on `window` but the shared setup never
// promotes them to globalThis. Pull them off the document's defaultView
// (which IS jsdom's window) so the walker has the constants it expects.
if (typeof _g.NodeFilter === 'undefined' && typeof document !== 'undefined') {
  const win = document.defaultView as unknown as Record<string, unknown> | null;
  if (win && win.NodeFilter) _g.NodeFilter = win.NodeFilter;
}
// Radix's Select/Menu primitives call element.scrollIntoView on the focused
// candidate when their content opens. jsdom doesn't implement it. A no-op
// stub is sufficient for the assertions we care about.
if (typeof _g.Element !== 'undefined') {
  const proto = (_g.Element as { prototype: Record<string, unknown> }).prototype;
  if (typeof proto.scrollIntoView !== 'function') {
    proto.scrollIntoView = function scrollIntoView() { /* no-op */ };
  }
  if (typeof proto.hasPointerCapture !== 'function') {
    proto.hasPointerCapture = function hasPointerCapture() { return false; };
  }
  if (typeof proto.releasePointerCapture !== 'function') {
    proto.releasePointerCapture = function releasePointerCapture() { /* no-op */ };
  }
  if (typeof proto.setPointerCapture !== 'function') {
    proto.setPointerCapture = function setPointerCapture() { /* no-op */ };
  }
}

/* ---------- Mocks ---------- */

// Capture navigation calls so we can assert that selecting a Canopy result
// routes into the Cortex canopy-entries detail. We override only useNavigate
// in the react-router-dom module — the factory must NOT re-enter
// `import('react-router-dom')` (that deadlocks bun's mock loader). We
// snapshot the actual module via a static `import * as ReactRouterDom` at
// the top so the factory can synchronously spread its symbols.
const navigateMock = vi.fn();

mock.module('react-router-dom', () => ({
  ...ReactRouterDom,
  useNavigate: () => navigateMock,
}));

// fetchJson is the lowest-level hook the search request flows through. We
// intercept it so we can assert the URL the Canopy facet builds and return a
// canned canopy result.
const fetchJsonMock = vi.fn();

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  postJson: vi.fn(),
  putJson: vi.fn(),
  deleteJson: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown) {
      super(`API error ${status}`);
    }
  },
}));

// Imported AFTER the mocks so the module-level fetchJson resolves to the stub.
const { GlobalSearch } = await import(
  '../../packages/myco/ui/src/components/search/GlobalSearch'
);

/* ---------- Helpers ---------- */

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderSearch() {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobalSearch open={true} onOpenChange={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/* ---------- Tests ---------- */

describe('GlobalSearch — Canopy facet', () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    navigateMock.mockReset();
  });

  it('renders a "Canopy" facet option in the scope dropdown', async () => {
    fetchJsonMock.mockResolvedValue({ mode: 'semantic', results: [] });
    renderSearch();
    // Open the facet select
    const facetTrigger = await screen.findByLabelText('Facet');
    fireEvent.click(facetTrigger);
    expect(await screen.findByText('Canopy')).toBeInTheDocument();
  });

  it('routes the search through type=canopy when the Canopy facet is selected', async () => {
    fetchJsonMock.mockResolvedValue({
      mode: 'semantic',
      results: [
        {
          project_id: 'proj-1',
          path: 'packages/myco/src/canopy/scanner/index.ts',
          llm_description: 'Walks the project tree to harvest canopy entries.',
          language: 'typescript',
          score: 0.91,
        },
      ],
    });

    renderSearch();

    // Select "Canopy" facet
    const facetTrigger = await screen.findByLabelText('Facet');
    fireEvent.click(facetTrigger);
    const canopyOption = await screen.findByRole('option', { name: 'Canopy' });
    fireEvent.click(canopyOption);

    // Type a query (>2 chars to clear the SEARCH_MIN_LENGTH gate)
    const input = screen.getByPlaceholderText('Search sessions, spores, plans…');
    fireEvent.change(input, { target: { value: 'scanner' } });

    // Wait for debounce (300 ms) + fetch
    await waitFor(
      () => {
        const calls = fetchJsonMock.mock.calls.map((c) => c[0] as string);
        expect(calls.some((url) => url.includes('type=canopy') && url.includes('q=scanner'))).toBe(true);
      },
      { timeout: 1500 },
    );
  });

  it('renders canopy result rows with path, description, language, and score', async () => {
    fetchJsonMock.mockResolvedValue({
      mode: 'semantic',
      results: [
        {
          project_id: 'proj-1',
          path: 'packages/myco/src/canopy/scanner/index.ts',
          llm_description: 'Walks the project tree to harvest canopy entries.',
          language: 'typescript',
          score: 0.91,
        },
      ],
    });

    renderSearch();

    // Switch to Canopy facet
    fireEvent.click(await screen.findByLabelText('Facet'));
    fireEvent.click(await screen.findByRole('option', { name: 'Canopy' }));

    fireEvent.change(screen.getByPlaceholderText('Search sessions, spores, plans…'), {
      target: { value: 'scanner' },
    });

    const row = await screen.findByTestId('search-result-canopy', {}, { timeout: 1500 });
    expect(row.textContent).toContain('packages/myco/src/canopy/scanner/index.ts');
    expect(row.textContent).toContain('Walks the project tree to harvest canopy entries.');
    expect(row.textContent?.toLowerCase()).toContain('typescript');
    // Score is rendered as a percent via the ScoreBadge
    expect(row.textContent).toContain('91%');
  });

  it('navigates to the Cortex canopy-entries tab with the path encoded when a result is clicked', async () => {
    fetchJsonMock.mockResolvedValue({
      mode: 'semantic',
      results: [
        {
          project_id: 'proj-1',
          path: 'packages/myco/src/canopy/scanner/index.ts',
          llm_description: 'Walks the project tree.',
          language: 'typescript',
          score: 0.91,
        },
      ],
    });

    renderSearch();

    fireEvent.click(await screen.findByLabelText('Facet'));
    fireEvent.click(await screen.findByRole('option', { name: 'Canopy' }));
    fireEvent.change(screen.getByPlaceholderText('Search sessions, spores, plans…'), {
      target: { value: 'scanner' },
    });

    const row = await screen.findByTestId('search-result-canopy', {}, { timeout: 1500 });
    await act(async () => {
      fireEvent.click(row);
    });

    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0][0] as string;
    expect(target.startsWith('/cortex?tab=canopy&section=entries&path=')).toBe(true);
    expect(target).toContain(encodeURIComponent('packages/myco/src/canopy/scanner/index.ts'));
  });
});
