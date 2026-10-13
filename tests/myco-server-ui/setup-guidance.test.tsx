import { afterEach, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotAMember } from '../../packages/myco-server/ui/src/pages/NotAMember';
import { SignedOut } from '../../packages/myco-server/ui/src/pages/SignedOut';
import { LinkPage } from '../../packages/myco-server/ui/src/pages/Link';
import { holdPendingLink } from '../../packages/myco-server/ui/src/lib/pending-link';
import { dashboardMe } from '../helpers/dashboard-permissions';

const originalFetch = globalThis.fetch;
let client: QueryClient | undefined;
afterEach(() => { cleanup(); client?.clear(); window.sessionStorage.clear(); globalThis.fetch = originalFetch; });

it('sends the unclaimed owner back to setup on the creating machine', () => {
  render(<MemoryRouter><NotAMember login="owner" membership={{ state: 'unclaimed', reason: null }} /></MemoryRouter>);
  expect(screen.getByText('This Myco has no owner yet, so nobody can approve this machine. Whoever created it must run myco setup on the machine that created it, then open and complete the fresh owner link.')).toBeTruthy();
});

it('sends unconfigured GitHub sign-in back to setup for this address', () => {
  render(<SignedOut unconfigured />);
  expect(screen.getByText(`GitHub sign-in is not set up for this Myco. Whoever created it must run myco setup for ${window.location.origin} on the machine that created it, then reload this page.`)).toBeTruthy();
});

it('explains how to replace an expired owner link through setup', async () => {
  holdPendingLink('x'.repeat(43));
  globalThis.fetch = (async input => String(input).includes('/auth/me')
    ? Response.json(dashboardMe({ member: null }))
    : Response.json({ error: 'owner_link_denied' }, { status: 403 })) as typeof fetch;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><LinkPage /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('This owner link has expired or was already used. On the machine that created this Myco, run myco setup again for a fresh link, then open and complete it.')).toBeTruthy();
});
