import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { reportWords } from '../../packages/myco-server/ui/src/components/operations/WakePanel';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris' } };
const PROJECTS = { projects: [{ projectId: 'x', name: 'Project X', createdAt: 0, sessionCount: 2, lastActivityAt: null }] };

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(routes: Record<string, (init?: RequestInit) => Response>): { requested: string[] } {
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    requested.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    return routes[url.pathname]?.(init) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { requested };
}

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

describe('housekeeping on the Operations page', () => {
  it('runs the tick on the button and says what it did in the reader\'s words', async () => {
    const { requested } = server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/wake': () => Response.json({ state: 'sleep', heldBy: null, idleMs: 2_000_000, jobs: [{ name: 'agent-run-retention', changed: 3, failed: null }, { name: 'run-stale-sweep', changed: 1, failed: null }], nextWakeMs: 300_000 }),
    });
    mount('/operations');
    const button = await screen.findByRole('button', { name: 'Run housekeeping now' });
    expect(screen.getByText(/Old run records are removed/).textContent).toContain('on the server\'s own clock');
    fireEvent.click(button);
    expect((await screen.findByText(/The server is asleep/)).textContent).toBe('The server is asleep. Removed 3 old run records; closed 1 run whose runtime went away. Next wake in 5 min.');
    expect(requested).toContain('POST /api/wake');
  });

  it('says when the server could not run its housekeeping', async () => {
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/wake': () => new Response(null, { status: 503 }),
    });
    mount('/operations');
    fireEvent.click(await screen.findByRole('button', { name: 'Run housekeeping now' }));
    expect(await screen.findByText('The server could not run its housekeeping right now.')).toBeTruthy();
  });

  it('words every state, a held state, a failed job, and deep sleep', () => {
    expect(reportWords({ state: 'idle', heldBy: 'run:live', idleMs: 1, jobs: [], nextWakeMs: 60_000 })).toBe('The server is idle while a run is live. Nothing was due. Next wake in 1 min.');
    expect(reportWords({ state: 'deep_sleep', heldBy: null, idleMs: null, jobs: [], nextWakeMs: null })).toBe('The server is in deep sleep. Nothing was due. No wake is scheduled while it sleeps this deeply.');
    expect(reportWords({ state: 'active', heldBy: null, idleMs: 0, jobs: [{ name: 'agent-run-retention', changed: 0, failed: 'db' }, { name: 'run-stale-sweep', changed: 0, failed: null }], nextWakeMs: 60_000 }))
      .toBe('The server is in use. Old run records could not be removed; closed 0 runs whose runtime went away. Next wake in 1 min.');
  });
});
