// @vitest-environment jsdom

import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { GitIdentityPill } from '../../packages/myco/ui/src/components/ui/git-identity-pill';
import type { GitIdentity } from '../../packages/myco/ui/src/hooks/use-git-identity';
import { gitIdentityInitials } from '../../packages/myco/ui/src/hooks/use-git-identity';

function renderWithIdentity(identity: GitIdentity | undefined, opts?: { isPending?: boolean; isError?: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['git-identity'], identity);
  return render(
    <QueryClientProvider client={client}>
      <GitIdentityPill
        data={identity}
        isPending={opts?.isPending ?? false}
        isError={opts?.isError ?? false}
      />
    </QueryClientProvider>,
  );
}

function renderLinkedIdentity(identity: GitIdentity, to: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <GitIdentityPill
          data={identity}
          isPending={false}
          isError={false}
          to={to}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('GitIdentityPill', () => {
  it('renders branch + initials when given a clean state', () => {
    renderWithIdentity({
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
      author: 'Chris Kirby',
      author_email: 'chris@example.com',
      head_sha: 'deadbeef',
    });
    expect(screen.getByText('main')).toBeDefined();
    expect(screen.getByText('CK')).toBeDefined();
  });

  it('shows the dirty marker when the working tree is dirty', () => {
    renderWithIdentity({
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      author: 'Chris Kirby',
      author_email: 'chris@example.com',
      head_sha: 'd',
    });
    expect(screen.getByTitle(/working tree dirty/i)).toBeDefined();
  });

  it('shows ahead/behind counts when set', () => {
    renderWithIdentity({
      branch: 'feature/x',
      dirty: false,
      ahead: 3,
      behind: 2,
      author: 'A B',
      author_email: 'a@example.com',
      head_sha: '0',
    });
    expect(screen.getByText(/↑3/)).toBeDefined();
    expect(screen.getByText(/↓2/)).toBeDefined();
  });

  it('renders an em dash when pending', () => {
    renderWithIdentity(undefined, { isPending: true });
    expect(screen.getByText('—')).toBeDefined();
  });

  it('links to release provenance settings when given a target', () => {
    renderLinkedIdentity({
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
      author: 'Chris Kirby',
      author_email: 'chris@example.com',
      head_sha: 'deadbeef',
    }, '/settings?configSection=release-provenance#release-provenance');
    expect(screen.getByRole('link', { name: /main/i }).getAttribute('href')).toBe('/settings?configSection=release-provenance#release-provenance');
  });
});

describe('gitIdentityInitials', () => {
  it('returns the first two letters for a single-word name', () => {
    expect(gitIdentityInitials('Chris')).toBe('CH');
  });
  it('returns first+last initial for multi-word', () => {
    expect(gitIdentityInitials('Chris Kirby')).toBe('CK');
    expect(gitIdentityInitials('Alice Bob Charlie')).toBe('AC');
  });
  it('returns ? for empty author', () => {
    expect(gitIdentityInitials(undefined)).toBe('?');
    expect(gitIdentityInitials('')).toBe('?');
  });
});
