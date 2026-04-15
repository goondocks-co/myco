// @vitest-environment jsdom

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Mcp from '../../packages/myco-collective/ui/src/pages/Mcp';

const REAL_TOKEN = 'secret-token-abcdef-xyz';

function renderWithClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <Mcp />
    </QueryClientProvider>,
  );
}

describe('MCP secrets reveal', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const writeTextMock = vi.fn<(value: string) => Promise<void>>();

  const resolveUrl = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  };

  beforeEach(() => {
    writeTextMock.mockReset();
    writeTextMock.mockResolvedValue(undefined);

    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: writeTextMock },
    });

    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const url = resolveUrl(input);
      if (url.endsWith('/api/auth/access')) {
        return new Response(JSON.stringify({
          collective_name: 'Test',
          mcp_endpoint: 'https://example/mcp',
          mcp_token: REAL_TOKEN,
          mcp_token_hash: 'deadbeef',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders all secrets redacted by default', async () => {
    renderWithClient();
    await screen.findByText('Managed agent MCP JSON');
    expect(screen.queryByText(REAL_TOKEN)).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`Authorization: Bearer ${REAL_TOKEN}`))).not.toBeInTheDocument();
  });

  it('reveals all secrets when eye toggle clicked', async () => {
    renderWithClient();
    await screen.findByText('Managed agent MCP JSON');
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal token' }));

    const matches = screen.getAllByText((_, node) => node?.textContent?.includes(REAL_TOKEN) ?? false);
    expect(matches.length).toBeGreaterThan(0);
    expect((await screen.findAllByText(new RegExp(`Authorization: Bearer ${REAL_TOKEN}`))).length).toBeGreaterThan(0);
  });

  it('copy button on token field places real token on clipboard even when hidden', async () => {
    renderWithClient();
    await screen.findByText('Managed agent MCP JSON');
    const copyButtons = await screen.findAllByLabelText(/Copy MCP Access Token/);
    fireEvent.click(copyButtons[0]);
    expect(writeTextMock).toHaveBeenCalledWith(REAL_TOKEN);
  });

  it('copy button on Authorization Header copies the real token even when hidden', async () => {
    renderWithClient();
    await screen.findByText('Managed agent MCP JSON');
    const copyButtons = await screen.findAllByLabelText(/Copy Authorization Header/);
    fireEvent.click(copyButtons[0]);
    expect(writeTextMock).toHaveBeenCalledWith(`Authorization: Bearer ${REAL_TOKEN}`);
  });

  it('copy button on snippet cards copies the real token even when hidden', async () => {
    renderWithClient();
    await screen.findByText('Managed agent MCP JSON');

    const claudeCopy = screen.getByLabelText(/Copy Managed agent MCP JSON snippet/);
    fireEvent.click(claudeCopy);
    const claudeCall = writeTextMock.mock.calls.at(-1)?.[0] ?? '';
    expect(claudeCall).toContain(REAL_TOKEN);
    expect(claudeCall).not.toMatch(/\*+/);

    const inspectorCopy = screen.getByLabelText(/Copy MCP Inspector snippet/);
    fireEvent.click(inspectorCopy);
    const inspectorCall = writeTextMock.mock.calls.at(-1)?.[0] ?? '';
    expect(inspectorCall).toContain(`Authorization: Bearer ${REAL_TOKEN}`);
    expect(inspectorCall).not.toMatch(/\*+/);
  });
});
