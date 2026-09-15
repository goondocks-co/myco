import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { reportWords } from '../../packages/myco-server/ui/src/components/operations/WakePanel';
import { progressWords } from '../../packages/myco-server/ui/src/components/operations/TitlingBackfillPanel';

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
  it('shows a refused backup reason and the operator recovery path', async () => {
    const reason = 'The assembled backup is past the supported byte bound.';
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/backups': (init) => init?.method === 'POST'
        ? Response.json({ error: 'bad_request', reason }, { status: 400 })
        : Response.json({ backups: [] }),
    });
    mount('/operations');
    fireEvent.click(await screen.findByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'operator backup and recovery procedure' }).getAttribute('href'))
      .toBe('https://github.com/goondocks-co/myco/blob/main/docs/architecture/deployment-recovery.md');
  });

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

  it('shows where the imported-session backfill stands and starts or stops it through its own route', async () => {
    let progress = { scheduledTasksEnabled: true, backfillEnabled: false, runsPerDay: 24, intervalSeconds: 900, enabled: false, remaining: 12, usedToday: 0, inFlight: 0, completedToday: 0, failedToday: 0 };
    const puts: unknown[] = [];
    const { requested } = server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/titling-backfill': (init) => {
        if (init?.method === 'PUT') {
          puts.push(JSON.parse(String(init.body)));
          progress = { ...progress, backfillEnabled: true, enabled: true, usedToday: 5, inFlight: 5 };
        }
        return Response.json(progress);
      },
    });
    mount('/operations');
    expect((await screen.findByText(/12 imported sessions still to title/)).textContent).toContain('The backfill is stopped.');
    fireEvent.click(await screen.findByRole('button', { name: 'Start backfill' }));
    expect((await screen.findByText(/Today: 5 of 24 started/)).textContent).toContain('5 in flight, 0 titled, 0 failed.');
    expect(puts).toEqual([{ enabled: true }]);
    expect(await screen.findByRole('button', { name: 'Stop backfill' })).toBeTruthy();
    expect(requested).toContain('PUT /api/titling-backfill');
  });

  it('words the backfill in every state', () => {
    const base = { scheduledTasksEnabled: true, backfillEnabled: true, runsPerDay: 24, intervalSeconds: 900, enabled: true, remaining: 0, usedToday: 3, inFlight: 1, completedToday: 2, failedToday: 0 };
    expect(progressWords(base)).toBe('Every imported session with material has a title or an attempt. Today: 3 of 24 started, 1 in flight, 2 titled, 0 failed.');
    expect(progressWords({ ...base, remaining: 1, runsPerDay: null })).toBe('1 imported session still to title. Today: 3 started, 1 in flight, 2 titled, 0 failed.');
    expect(progressWords({ ...base, scheduledTasksEnabled: false, enabled: false })).toBe('Every imported session with material has a title or an attempt. The backfill is on but runs only while scheduled intelligence is on; turn that on in Settings.');
    expect(progressWords({ ...base, backfillEnabled: false, enabled: false, remaining: 2 })).toBe('2 imported sessions still to title. The backfill is stopped.');
  });
});
