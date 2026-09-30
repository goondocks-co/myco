/**
 * Every address the dashboard used to answer at still leads somewhere real.
 *
 * `routes/moved.tsx` holds the one table of old addresses. Each entry here is
 * an example of one, walked as a reader would arrive from an old link: it must
 * land on the address its page has now, with what the old one carried (a list's
 * filters, a run's id, a measures window), on a page that exists. Every table
 * entry needs an example, so an address added to the table is walked too.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import { MOVED } from '../../packages/myco-server/ui/src/routes/moved';

const ADMIN = { sub: '583231', login: 'ada', member: { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', role: 'admin' as const } };
const MEMBER = { sub: '770001', login: 'lin', member: { id: 'mem_Hn5-pC0dJfA9sE_u', label: 'Lin', role: 'member' as const } };
const PROJECT = 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11';

/** For each old address in the table, one arrival at it and where that must land, as the admin and, where it differs, as a member. */
const EXAMPLES: Readonly<Record<string, { from: string; admin: string; member?: string }>> = {
  '/notifications': { from: '/notifications', admin: '/' },
  '/spores': { from: '/spores?q=port&type=gotcha&tab=x', admin: '/knowledge?q=port&type=gotcha' },
  '/plans': { from: '/plans?q=filter', admin: '/knowledge/plans?q=filter' },
  '/p/:projectId/spores': { from: `/p/${PROJECT}/spores?status=superseded`, admin: `/p/${PROJECT}/knowledge?status=superseded` },
  '/p/:projectId/plans': { from: `/p/${PROJECT}/plans?q=board`, admin: `/p/${PROJECT}/knowledge/plans?q=board` },
  '/p/:projectId/runs': { from: `/p/${PROJECT}/runs?window=today`, admin: `/p/${PROJECT}/work?window=today` },
  '/p/:projectId/runs/:runId': { from: `/p/${PROJECT}/runs/run_d4e5f6a7b8?window=week`, admin: `/p/${PROJECT}/work/runs/run_d4e5f6a7b8?window=week` },
  '/access': { from: '/access', admin: '/people', member: '/me/machines' },
  '/p/:projectId/access': { from: `/p/${PROJECT}/access`, admin: `/p/${PROJECT}/settings#access-keys` },
  '/status': { from: '/status', admin: '/status/health#status' },
  '/measures': { from: '/measures?window=7', admin: '/status/health?window=7#measures' },
  '/operations': { from: '/operations', admin: '/status/health#upkeep' },
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  forgetProject();
});

/** The signed-in reader and the one project; every other read answers empty, so the page it lands on renders. */
function serve(who: typeof ADMIN | typeof MEMBER): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const { pathname } = new URL(href, 'https://s');
    if (pathname === '/auth/me') return Response.json(who);
    if (pathname === '/api/projects') {
      return Response.json({ projects: [{ projectId: PROJECT, name: 'Myco', createdAt: 0, sessionCount: 0, lastActivityAt: null, archivedAt: null, archivedBy: null }] });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

function Location() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AppearanceProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <App />
          <Location />
        </MemoryRouter>
      </QueryClientProvider>
    </AppearanceProvider>,
  );
}

async function arrive(from: string, who: typeof ADMIN | typeof MEMBER): Promise<{ at: string; notFound: boolean }> {
  serve(who);
  mount(from);
  // Landed once the address stops being the old one, and the shell has read who is asking.
  await waitFor(() => expect(screen.getByTestId('location').textContent).not.toBe(from));
  await waitFor(() => expect(document.querySelector('main')).not.toBeNull());
  const result = { at: screen.getByTestId('location').textContent ?? '', notFound: document.querySelector('[data-not-found]') !== null };
  cleanup();
  return result;
}

describe('old addresses', () => {
  it('has an example for every address the table keeps, and none for one it dropped', () => {
    expect(MOVED.map((address) => address.from).sort()).toEqual(Object.keys(EXAMPLES).sort());
  });

  for (const address of MOVED) {
    it(`${address.from} leads to where its page is now`, async () => {
      const example = EXAMPLES[address.from]!;
      expect(await arrive(example.from, ADMIN)).toEqual({ at: example.admin, notFound: false });
      expect(await arrive(example.from, MEMBER)).toEqual({ at: example.member ?? example.admin, notFound: false });
    });
  }
});
