// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Mcp from '../../packages/myco-collective/ui/src/pages/Mcp';

function renderMcp() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <Mcp />
    </QueryClientProvider>,
  );
}

describe('Collective MCP page', () => {
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

      if (url.endsWith('/api/auth/access')) {
        return new Response(JSON.stringify({
          collective_name: 'OSS Collective',
          mcp_endpoint: 'https://oss.goondocks.workers.dev/mcp',
          mcp_token: 'abcdef1234567890fedcba',
          admin_token_hash: 'admin1234',
          mcp_token_hash: 'mcp12345',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows hosted access details and Claude-first setup snippets', async () => {
    renderMcp();

    expect(await screen.findByText('Hosted MCP access for the Collective.')).toBeInTheDocument();
    expect(await screen.findByText('Managed agent MCP JSON')).toBeInTheDocument();
    expect(
      (await screen.findAllByText((content) => content.includes('https://oss.goondocks.workers.dev/mcp'))).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Authorization: Bearer abcdef1234567890fedcba/).length).toBeGreaterThan(0);
    expect(screen.getByText('Claude Code plugin support')).toBeInTheDocument();
    expect(screen.getByText('Codex plugin support')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rotate token' })).toBeInTheDocument();
  });
});
