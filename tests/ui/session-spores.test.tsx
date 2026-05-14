// @vitest-environment jsdom

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionSpores } from '../../packages/myco/ui/src/components/sessions/SessionSpores';

const SAMPLE_SPORES = {
  spores: [
    {
      id: 'spore-1',
      observation_type: 'decision',
      status: 'active',
      content: '# Why we chose Postgres\n\nIt fits the existing schema...',
      session_id: 'session-a',
      created_at: 1_700_000_000,
      updated_at: 1_700_000_000,
      importance: 3,
      tags: [],
    },
    {
      id: 'spore-2',
      observation_type: 'gotcha',
      status: 'active',
      content: 'The migration silently dropped rows when run twice.',
      session_id: 'session-a',
      created_at: 1_700_000_100,
      updated_at: 1_700_000_100,
      importance: 4,
      tags: [],
    },
  ],
  total: 2,
};

beforeEach(() => {
  // @ts-expect-error — test scaffold
  globalThis.fetch = mock(async (url: string) => {
    if (typeof url === 'string' && url.includes('/spores?')) {
      return new Response(JSON.stringify(SAMPLE_SPORES), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
});

function renderWith(sessionId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionSpores sessionId={sessionId} />
    </QueryClientProvider>,
  );
}

describe('SessionSpores', () => {
  it('renders one card per spore', async () => {
    renderWith('session-a');
    await screen.findByText(/Why we chose Postgres/i);
    expect(screen.getByText(/Why we chose Postgres/i)).toBeDefined();
    expect(screen.getByText(/migration silently dropped/i)).toBeDefined();
  });

  it('renders kind and status chips per card', async () => {
    renderWith('session-a');
    await screen.findByText(/decision/i);
    expect(screen.getByText(/decision/i)).toBeDefined();
    expect(screen.getByText(/gotcha/i)).toBeDefined();
    const activeChips = screen.getAllByText(/active/i);
    expect(activeChips.length).toBeGreaterThanOrEqual(2);
  });

  it('expands a card inline on click', async () => {
    renderWith('session-a');
    const firstCard = await screen.findByText(/Why we chose Postgres/i);
    fireEvent.click(firstCard.closest('[role="button"]') ?? firstCard);
    expect(screen.getByText(/It fits the existing schema/i)).toBeDefined();
  });

  it('renders empty state when there are no spores', async () => {
    // @ts-expect-error
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ spores: [], total: 0 }), { status: 200 }));
    renderWith('session-b');
    await screen.findByText(/No spores derived/i);
    expect(screen.getByText(/No spores derived/i)).toBeDefined();
  });
});
