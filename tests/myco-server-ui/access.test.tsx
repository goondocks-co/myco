import { afterEach, describe, expect, it } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris' } };
const MEMBERS = { members: [
  { id: 'mem_1', label: 'chris', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 2 },
  { id: 'mem_2', label: 'laptop', linked: false, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 0 },
] };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function server(routes: Record<string, (init?: RequestInit) => Response>): { posts: { path: string; body: unknown }[] } {
  const posts: { path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(href, 'https://s').pathname;
    if (init?.method === 'POST') posts.push({ path: pathname, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return routes[pathname]?.(init) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { posts };
}

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

describe('Deployment Access', () => {
  it('lists members in user vocabulary, marks you, and the remove confirm says what stops', async () => {
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json({ projects: [] }),
      '/api/members': () => Response.json(MEMBERS),
      '/api/enrollment': () => Response.json({ invitations: [] }),
      '/api/credentials': () => Response.json({ rows: [], cursor: null }),
    });
    mount('/access');
    expect(await screen.findByText('chris')).toBeTruthy();
    expect(screen.getByText('you')).toBeTruthy();
    expect(screen.getByText('2 runtimes')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Remove')[0]!);
    expect(await screen.findByText('Remove yourself?')).toBeTruthy();
    expect(screen.getByText(/can no longer sign in/)).toBeTruthy();
  });

  it('mints an invitation and shows the key once', async () => {
    const { posts } = server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json({ projects: [] }),
      '/api/members': () => Response.json(MEMBERS),
      '/api/enrollment': (init) => init?.method === 'POST' ? Response.json({ key: 'k'.repeat(43), id: 'en_1', expiresAt: Date.now() + 60_000 }, { status: 201 }) : Response.json({ invitations: [] }),
      '/api/credentials': () => Response.json({ rows: [], cursor: null }),
    });
    mount('/access');
    fireEvent.click(await screen.findByText('Invite'));
    fireEvent.click(await screen.findByText('Create invitation'));
    expect((await screen.findByTestId('key-reveal')).textContent).toBe('k'.repeat(43));
    expect(screen.getByText(/shown once/)).toBeTruthy();
    expect(posts).toEqual([{ path: '/api/enrollment', body: { ttlMinutes: 60 } }]);
  });
});

describe('Project Access', () => {
  it('lists external agents with when they were last used, and adding one shows the key once', async () => {
    const { posts } = server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json({ projects: [{ projectId: 'proj_1', name: 'Alpha', createdAt: 0, sessionCount: 0, lastActivityAt: null }] }),
      '/api/members': () => Response.json(MEMBERS),
      '/api/projects/proj_1/grants': (init) => init?.method === 'POST'
        ? Response.json({ key: 'mycoext_' + 'x'.repeat(43), id: 'eg_2' }, { status: 201 })
        : Response.json({ grants: [{ id: 'eg_1', projectId: 'proj_1', label: 'review bot', createdBy: 'mem_1', createdAt: 0, lastUsedAt: null, revokedAt: null, revokedBy: null, rotatedTo: null }] }),
    });
    mount('/p/proj_1/access');
    expect(await screen.findByText('review bot')).toBeTruthy();
    expect(screen.getByText(/never used/)).toBeTruthy();
    fireEvent.click(screen.getByText('Add external agent'));
    fireEvent.click(await screen.findByText('Create key'));
    expect((await screen.findByTestId('key-reveal')).textContent).toBe('mycoext_' + 'x'.repeat(43));
    expect(posts).toEqual([{ path: '/api/projects/proj_1/grants', body: {} }]);
  });
});
