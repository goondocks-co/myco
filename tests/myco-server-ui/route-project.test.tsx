/**
 * A page under one project waits for the projects' read; a page across every
 * project starts at once.
 *
 * `routes/route-project.tsx` holds a project page back until the list answers,
 * so it never asks the server about a project that does not exist, never shows
 * an archived project without its notice, and never names the project with a
 * stand-in before its real name. `/` with no project at all goes to Projects
 * without Today ever showing. Each check watches the document from the first
 * render, so a flash of the wrong page fails it, not only the settled one.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';

const ADMIN = { sub: '583231', login: 'ada', member: { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', role: 'admin' as const } };
const MYCO = 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11';
const ARCHIVED = 'proj_a71a5c0e2b9d4f8e6c3a1b7d5e9f0c22';
const NOW = Date.now();
const project = (projectId: string, name: string, archivedAt: number | null = null) =>
  ({ projectId, name, createdAt: 0, sessionCount: 1, lastActivityAt: NOW - 60_000, archivedAt, archivedBy: archivedAt === null ? null : ADMIN.member.id });

const originalFetch = globalThis.fetch;
let observer: MutationObserver | null = null;
afterEach(() => {
  observer?.disconnect();
  observer = null;
  cleanup();
  globalThis.fetch = originalFetch;
  forgetProject();
});

/**
 * The server: the projects' read answers only when `release` is called, and
 * every other read answers empty. Each request is recorded.
 */
function server(projects: unknown[]): { asked: string[]; release: () => void } {
  const asked: string[] = [];
  let release: () => void = () => undefined;
  const listed = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/auth/me') return Response.json(ADMIN);
    if (url.pathname === '/api/projects') { await listed; return Response.json({ projects }); }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { asked, release: () => release() };
}

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

/** Mounts the dashboard at a path, noting from the first render every time `seen` finds something in the document. */
function mount(path: string, seen: (doc: Document) => string | null = () => null): string[] {
  const noticed: string[] = [];
  observer = new MutationObserver(() => { const what = seen(document); if (what !== null && !noticed.includes(what)) noticed.push(what); });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <AppearanceProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <App />
          <Location />
        </MemoryRouter>
      </QueryClientProvider>
    </AppearanceProvider>,
  );
  return noticed;
}

describe('a page under one project', () => {
  it('shows a loading state until the list answers, then Not found for an id it lacks, asking nothing about that id', async () => {
    const { asked, release } = server([project(MYCO, 'Myco')]);
    mount('/p/proj_0000000000000000000000000000dead/sessions');
    expect(await screen.findByRole('status', { name: 'Loading the project' })).toBeTruthy();
    release();
    await waitFor(() => expect(document.querySelector('[data-not-found]')).not.toBeNull());
    expect(asked.filter((line) => line.includes('dead'))).toEqual([]);
  });

  it('shows an archived project\'s notice from the page\'s first render', async () => {
    const { release } = server([project(ARCHIVED, 'Atlas web', NOW - 3_600_000)]);
    // Any render of the day's page without its archived notice is a flash of the wrong page.
    const noticed = mount(`/p/${ARCHIVED}`, (doc) => (doc.querySelector('[data-today]') !== null && doc.querySelector('[data-testid="archived-banner"]') === null ? 'today without its notice' : null));
    release();
    await waitFor(() => expect(document.querySelector('[data-testid="archived-banner"]')).not.toBeNull());
    expect(noticed).toEqual([]);
  });

  it('names the project in Project settings, never "this project" first', async () => {
    const { release } = server([project(MYCO, 'Myco')]);
    const noticed = mount(`/p/${MYCO}/settings`, (doc) => (doc.body.textContent?.includes('this project:') === true ? 'a stand-in name' : null));
    release();
    await waitFor(() => expect(document.body.textContent).toContain('How Myco works in Myco:'));
    expect(noticed).toEqual([]);
  });
});

describe('the start', () => {
  it('goes to Projects when the server holds none, without Today ever showing', async () => {
    const { release } = server([]);
    const noticed = mount('/', (doc) => (doc.querySelector('[data-today]') !== null ? 'Today' : null));
    expect(await screen.findByRole('status', { name: 'Loading today' })).toBeTruthy();
    release();
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/projects'));
    expect(noticed).toEqual([]);
  });

  it('starts the day\'s reads beside the projects\' read, before the list answers', async () => {
    const { asked } = server([project(MYCO, 'Myco')]);
    mount('/');
    await waitFor(() => expect(asked.some((line) => line.startsWith('/api/sessions?'))).toBe(true));
    expect(screen.getByRole('status', { name: 'Loading today' })).toBeTruthy();
  });
});
