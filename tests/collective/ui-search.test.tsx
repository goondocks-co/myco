// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Search from '../../packages/myco-collective/ui/src/pages/Search';

function renderSearch() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <Search />
    </QueryClientProvider>,
  );
}

describe('Collective search UI', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);

      if (url.endsWith('/api/projects')) {
        return new Response(
          JSON.stringify({
            projects: [
              {
                id: 'northwind',
                name: 'Northwind',
                worker_url: 'https://northwind.example.workers.dev',
                api_key_hash: 'sha256:northwind',
                capabilities: ['search', 'spores'],
                package_version: '0.19.1',
                schema_version: 9,
                last_seen: 1776136200,
                registered_at: 1776130000,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.endsWith('/api/query') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: 'spore-1',
                score: 0.9823,
                table: 'spores',
                title: 'Collective config split',
                preview:
                  'Collective operator config moved to a home-scoped directory so multiple projects can share one Collective instance.',
                path: 'spores/decision/collective-config-split.md',
                observation_type: 'decision',
                session_id: 'session-123',
                project: {
                  id: 'northwind',
                  name: 'Northwind',
                  worker_url: 'https://northwind.example.workers.dev',
                },
              },
            ],
            errors: [
              {
                project: {
                  id: 'lagging',
                  name: 'Lagging Worker',
                  worker_url: 'https://lagging.example.workers.dev',
                },
                error: 'Timed out after 1500ms',
                status: 504,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders grouped results and inspector details after a search', async () => {
    renderSearch();

    fireEvent.change(screen.getByPlaceholderText('collective config split'), {
      target: { value: 'collective config split' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run search' }));

    expect(await screen.findByText('Some projects did not respond')).toBeInTheDocument();
    expect(await screen.findAllByText('Collective config split')).not.toHaveLength(0);
    expect(screen.getByText('spores/decision/collective-config-split.md')).toBeInTheDocument();
    expect(screen.getByText('Lagging Worker')).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/query',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
