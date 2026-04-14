// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
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

  it('keeps token-bearing fields and snippets masked until revealed', async () => {
    renderMcp();

    expect(await screen.findByText('Hosted MCP access for the Collective.')).toBeInTheDocument();
    expect(await screen.findByText('Managed agent MCP JSON')).toBeInTheDocument();
    expect(screen.getAllByText(/abcdef12\*+dcba/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Authorization: Bearer abcdef12\*+dcba/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Authorization: Bearer abcdef1234567890fedcba/)).not.toBeInTheDocument();
    expect(screen.getByText(/authorization_token\": \"abcdef12\*+dcba/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reveal token' }));

    expect((await screen.findAllByText(/Authorization: Bearer abcdef1234567890fedcba/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/authorization_token\": \"abcdef1234567890fedcba/)).toBeInTheDocument();
    expect(screen.getByText('Claude Code plugin support')).toBeInTheDocument();
    expect(screen.getByText('Codex plugin support')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rotate token' })).toBeInTheDocument();
  });
});
