/**
 * Every page says so when the server fails it, and never waits on a loading state for a read that already failed.
 *
 * Each route is mounted on the dashboard's own query client with every read but sign-in and the project list
 * answering 503, in a tab out of view: there a retry waits for the tab to return, so a page that shows only its
 * loading state until the last retry would show nothing else for as long as the tab stays hidden.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { createQueryClient } from '../../packages/myco-server/ui/src/lib/query-client';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris', role: 'admin' as const } };
const PROJECTS = { projects: [{ projectId: 'x', name: 'Project X', createdAt: 0, sessionCount: 2, lastActivityAt: null, archivedAt: null, archivedBy: null }] };

/** Every page under the project list, with the master/detail pages both bare and with a row named. */
export const PAGES = [
  '/p/x', '/p/x/sessions', '/p/x/sessions/s1', '/knowledge', '/knowledge/plans', '/p/x/knowledge', '/p/x/knowledge/plans', '/p/x/knowledge/map',
  '/p/x/spores/sp1', '/p/x/plans/11111111-2222-4333-8444-555555555555', '/p/x/runs', '/p/x/runs/r1',
  '/p/x/settings', '/people', '/me/machines', '/settings', '/settings/models', '/settings/capture', '/settings/backups', '/settings/access', '/status/health',
];

const originalFetch = globalThis.fetch;
beforeEach(() => { focusManager.setFocused(false); });
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; focusManager.setFocused(undefined); });

/** Sign-in answers; the project list answers where `projects` says; every other read fails with a 503. */
function failing(projects = true): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    if (url.pathname === '/auth/me') return Response.json(ME);
    if (url.pathname === '/api/projects' && projects) return Response.json(PROJECTS);
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }) as typeof fetch;
}

/** The page at `path` shows a failure, and nothing on it still says it is loading. */
async function saysItFailed(path: string): Promise<void> {
  render(<AppearanceProvider><QueryClientProvider client={createQueryClient()}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
  await waitFor(() => {
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(document.body.textContent ?? '').not.toMatch(/Loading/);
    // A count, not the elements: a failed match would print each element's whole object graph.
    expect(screen.queryAllByRole('status', { name: /Loading/ }).map((el) => el.getAttribute('aria-label'))).toEqual([]);
  }, { timeout: 3000 });
}

describe('a page whose reads the server fails', () => {
  it('says so where the project list every page stands on fails, on the Projects page and under a project', async () => {
    for (const path of ['/projects', '/p/x/sessions']) {
      failing(false);
      await saysItFailed(path);
      cleanup();
    }
  });

  for (const path of PAGES) {
    it(`says so on ${path}, with nothing left loading`, async () => {
      failing();
      await saysItFailed(path);
    });
  }
});
