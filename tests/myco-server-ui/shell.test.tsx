import { afterEach, describe, expect, it } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';

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
    server({ '/api/projects': () => Response.json({ projects: [] }) });
    mount('/projects');
    expect(await screen.findByText('No projects yet')).toBeTruthy();
    expect(await screen.findByText('myco setup')).toBeTruthy();
  });

  it('shows the sign-in state when the server answers 401', async () => {
    server({ '/api/projects': () => new Response(null, { status: 401 }) });
    mount('/projects');
    const link = await screen.findByText('Sign in with GitHub');
    expect(link.getAttribute('href')).toBe('/auth/login');
  });

  it('lists projects and links each to its home', async () => {
    server({
      '/api/projects': () => Response.json({ projects: [{ projectId: 'proj_1', name: 'Alpha', createdAt: 0, sessionCount: 3, lastActivityAt: null }] }),
    });
    mount('/projects');
    const card = await screen.findByRole('link', { name: /Alpha/ });
    expect(card.getAttribute('href')).toBe('/p/proj_1');
    expect(screen.getByText('3 sessions')).toBeTruthy();
  });

  it('says so when a project address names nothing', async () => {
    server({ '/api/projects': () => Response.json({ projects: [] }) });
    mount('/p/nope');
    expect(await screen.findByText('Not found')).toBeTruthy();
  });
});
