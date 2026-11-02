import { it, expect } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Conversation } from '../../../packages/myco-server/ui/src/features/sessions/Conversation';

it('opens the conversation without reading records outside its turns', async () => {
  const url = process.env.MYCO_CONVERSATION_BUDGET_URL;
  if (url === undefined) throw new Error('the D1 budget fixture must supply its URL');
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => original(new URL(String(input), url), init);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  try {
    render(<QueryClientProvider client={client}><MemoryRouter>
      <Conversation projectId="project" sessionId="session" turnsTotal={1} typedTotal={1} now={100} />
    </MemoryRouter></QueryClientProvider>);
    await screen.findByRole('list', { name: 'Conversation' });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    const opened = await original(new URL('/budget/opened', url));
    expect(opened.status).toBe(200);
  } finally {
    cleanup();
    client.clear();
    globalThis.fetch = original;
  }
}, 30_000);
