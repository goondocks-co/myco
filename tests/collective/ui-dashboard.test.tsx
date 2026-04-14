// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Dashboard from '../../packages/myco-collective/ui/src/pages/Dashboard';

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>,
  );
}

describe('Collective dashboard', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const resolveUrl = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  };

  beforeEach(() => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    fetchMock.mockImplementation(async (input) => {
      const url = resolveUrl(input);

      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({
          status: 'ok',
          collective_name: 'OSS Collective',
          project_count: 1,
          admin_token_hash: 'admin1234',
          mcp_token_hash: 'mcp12345',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.endsWith('/api/settings')) {
        return new Response(JSON.stringify({
          settings_overrides: {},
          settings_records: {},
          setting_definitions: [],
          capabilities: ['collective_settings'],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.endsWith('/api/projects')) {
        return new Response(JSON.stringify({
          projects: [{
            id: 'myco-main',
            name: 'myco-main',
            worker_url: 'https://myco-team.example.workers.dev',
            api_key_hash: 'hash',
            capabilities: ['search', 'digest', 'collective_proxy'],
            package_version: '0.1.1',
            schema_version: 12,
            last_seen: 1776140000,
            registered_at: 1776130000,
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the dashboard focused on project and override status', async () => {
    renderDashboard();

    expect(await screen.findByText('Connected workers')).toBeInTheDocument();
    expect((await screen.findAllByText('myco-main')).length).toBeGreaterThan(0);
    expect(screen.getByText('Recently updated')).toBeInTheDocument();
    expect(screen.queryByText('Cloud MCP Endpoint')).not.toBeInTheDocument();
  });
});
