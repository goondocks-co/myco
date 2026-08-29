/**
 * Nothing of the application is painted before the session is known.
 *
 * The shell is a static bundle served ahead of the Worker, so the sign-in
 * redirect is the client's to make: until `GET /auth/me` answers, the document
 * holds a blank surface and no data request has left the browser; then exactly
 * one of the sign-in page, the not-a-member page, or the application.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'machine_1' } };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** Answers each path from the table (a route may answer late or never); records every path asked. */
function server(routes: Record<string, () => Response | Promise<Response>>): { asked: string[] } {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(href, 'https://s').pathname;
    asked.push(pathname);
    return routes[pathname]?.() ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { asked };
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

const never = () => new Promise<Response>(() => undefined);

describe('the auth gate', () => {
  for (const path of ['/', '/projects', '/p/proj_1/sessions']) {
    it(`paints only the splash on ${path} while the session is unknown, and asks for nothing but /auth/me`, async () => {
      const { asked } = server({ '/auth/me': never, '/api/projects': () => Response.json({ projects: [] }) });
      mount(path);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.getByLabelText('Loading')).toBeTruthy();
      expect(screen.queryByRole('navigation')).toBeNull();
      expect(screen.queryByRole('main')).toBeNull();
      expect(screen.queryByRole('heading')).toBeNull();
      expect(screen.queryByText('Sign in with GitHub')).toBeNull();
      expect([...new Set(asked)]).toEqual(['/auth/me']);
    });
  }

  it('signed out, shows the sign-in page and nothing else', async () => {
    const { asked } = server({ '/auth/me': () => new Response(null, { status: 401 }), '/api/projects': () => Response.json({ projects: [] }) });
    mount('/projects');
    const link = await screen.findByText('Sign in with GitHub');
    expect(link.getAttribute('href')).toBe('/auth/login');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect([...new Set(asked)]).toEqual(['/auth/me']);
  });

  it('a server that does not answer the session gets the unreachable state, not the application', async () => {
    server({ '/auth/me': () => new Response(null, { status: 503 }) });
    mount('/projects');
    expect(await screen.findByText('This server is not answering')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('a member reaches the application', async () => {
    server({ '/auth/me': () => Response.json(ME), '/api/projects': () => Response.json({ projects: [] }) });
    mount('/projects');
    expect(await screen.findByText('No projects yet')).toBeTruthy();
  });

  it('a signed-in account that is not a member reaches the not-a-member page', async () => {
    server({ '/auth/me': () => Response.json({ ...ME, member: null }) });
    mount('/projects');
    await waitFor(() => expect(screen.queryByLabelText('Loading')).toBeNull());
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByText(/octocat/)).toBeTruthy();
  });

  it('/link renders signed out, so the identity-link key survives the sign-in ahead', async () => {
    server({ '/auth/me': () => new Response(null, { status: 401 }) });
    mount('/link');
    await waitFor(() => expect(screen.queryByLabelText('Loading')).toBeNull());
    expect(screen.queryByText('Sign in to Myco')).toBeNull();
  });
});

describe('the gate is the one place signed-out is decided', () => {
  const UI = fileURLToPath(new URL('../../packages/myco-server/ui/src/', import.meta.url));
  it('App mounts its routes inside the gate', () => {
    const app = readFileSync(`${UI}App.tsx`, 'utf8');
    expect(app).toMatch(/<AuthGate>\s*<Routes>/);
    expect(app).toMatch(/<\/Routes>\s*<\/AuthGate>/);
  });
  it('only the gate renders the sign-in page', () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true }) as { name: string; isDirectory(): boolean }[]) {
        const full = `${dir}${entry.name}`;
        if (entry.isDirectory()) walk(`${full}/`);
        else if (/\.tsx?$/.test(entry.name) && /from '[^']*\/pages\/SignedOut'/.test(readFileSync(full, 'utf8'))) importers.push(full.slice(UI.length));
      }
    };
    walk(UI);
    expect(importers).toEqual(['components/auth-gate.tsx']);
  });
  it('the layout decides nothing about being signed out', () => {
    const layout = readFileSync(`${UI}layout/Layout.tsx`, 'utf8');
    expect({ signedOutError: /SignedOutError/.test(layout), signIn: /sign in/i.test(layout) }).toEqual({ signedOutError: false, signIn: false });
  });
});
