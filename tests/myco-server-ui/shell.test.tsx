import { afterEach, describe, expect, it } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'machine_1' } };
const me = (body: unknown = ME, status = 200) => () => Response.json(body, { status });

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** Answers each path from the table; anything else is 404. Restored after every test so no sibling sees it. */
function server(routes: Record<string, () => Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(href, 'https://s').pathname;
    return routes[pathname]?.() ?? new Response(null, { status: 404 });
  }) as typeof fetch;
}

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AppearanceProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </AppearanceProvider>,
  );
}

describe('the dashboard shell', () => {
  it('hands a member with no projects to myco setup', async () => {
    server({ '/auth/me': me(), '/api/projects': () => Response.json({ projects: [] }) });
    mount('/projects');
    expect(await screen.findByText('No projects yet')).toBeTruthy();
    expect(await screen.findByText('myco setup')).toBeTruthy();
  });

  it('shows the sign-in state when the server answers 401', async () => {
    server({ '/auth/me': () => new Response(null, { status: 401 }), '/api/projects': () => new Response(null, { status: 401 }) });
    mount('/projects');
    const link = await screen.findByText('Sign in with GitHub');
    expect(link.getAttribute('href')).toBe('/auth/login');
  });

  it('lists projects and links each to its home', async () => {
    server({
      '/auth/me': me(),
      '/api/projects': () => Response.json({ projects: [{ projectId: 'proj_1', name: 'Alpha', createdAt: 0, sessionCount: 3, lastActivityAt: null }] }),
    });
    mount('/projects');
    const card = await screen.findByRole('link', { name: /Alpha/ });
    expect(card.getAttribute('href')).toBe('/p/proj_1');
    expect(screen.getByText('3 sessions')).toBeTruthy();
  });

  it('tells a signed-in account that no member is linked to it, naming the command, and never shows the shell', async () => {
    server({ '/auth/me': me({ ...ME, member: null }), '/api/projects': () => new Response(null, { status: 401 }) });
    mount('/projects');
    expect(await screen.findByText(/isn.t connected to a member yet/)).toBeTruthy();
    expect(screen.getByText('myco member link-github')).toBeTruthy();
    expect(screen.queryByText('Projects')).toBeNull();
  });

  it('serves the link page to a signed-in non-member: the confirm names the member the key was minted for, and the key is never sent until confirmed', async () => {
    const posts: unknown[] = [];
    server({
      '/auth/me': me({ ...ME, member: null }),
      '/auth/link': () => Response.json({ preview: { member: { id: 'mem_2', label: 'laptop' } } }),
    });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
      return inner(input, init);
    }) as typeof fetch;
    window.location.hash = '#' + 'k'.repeat(43);
    mount('/link');
    expect(await screen.findByText(/Connect this account/)).toBeTruthy();
    expect(screen.getByText('laptop')).toBeTruthy();
    expect(posts).toEqual([{ key: 'k'.repeat(43) }]);
    window.location.hash = '';
    window.sessionStorage.clear();
  });

  it('lands a pending link on /link after sign-in rather than on the member gate', async () => {
    window.sessionStorage.setItem('myco-pending-link', 'k'.repeat(43));
    server({ '/auth/me': () => new Response(null, { status: 401 }) });
    mount('/');
    expect(await screen.findByText('Connect your GitHub account')).toBeTruthy();
    expect(await screen.findByText('Sign in with GitHub')).toBeTruthy();
    window.sessionStorage.clear();
  });

  it('says so when a project address names nothing', async () => {
    server({ '/auth/me': me(), '/api/projects': () => Response.json({ projects: [] }) });
    mount('/p/nope');
    expect(await screen.findByText('Not found')).toBeTruthy();
  });
});
