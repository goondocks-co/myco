// @vitest-environment jsdom

import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Topbar } from '../../packages/myco/ui/src/layout/Topbar';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';

function renderTopbar(initialRoute: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <QueryClientProvider client={client}>
        <PowerProvider>
          <Topbar onOpenSearch={() => {}} onOpenNotifications={() => {}} unreadCount={0} />
        </PowerProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('Topbar', () => {
  it('renders the command-palette trigger', () => {
    renderTopbar('/');
    expect(screen.getByRole('button', { name: /search/i })).toBeDefined();
  });

  it('renders the notifications bell', () => {
    renderTopbar('/');
    expect(screen.getByRole('button', { name: /notifications/i })).toBeDefined();
  });

  it('renders the breadcrumb from the route', () => {
    renderTopbar('/sessions/abc-123');
    expect(screen.getByText('Sessions')).toBeDefined();
  });

  it('renders daemon, cortex, and git pills', () => {
    renderTopbar('/');
    expect(screen.getByText('daemon')).toBeDefined();
    expect(screen.getByText('cortex')).toBeDefined();
    expect(screen.getByTestId('git-identity-pill')).toBeDefined();
  });
});
