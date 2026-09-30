import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderMap } from '@goondocks/myco-shared/canopy';
import { CodeMapPanel } from '../../packages/myco-server/ui/src/features/knowledge/CodeMap';
import { STARTABLE_TASKS } from '../../packages/myco-server/ui/src/features/work/RunTask';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';

afterEach(() => { cleanup(); });

const repository = { url: 'https://example.test/team/source', branch: 'main', commit: 'a1b2c3d4e5f6'.padEnd(40, '0') };
const evidence = [{ path: 'src/main.ts', sha256: 'c'.repeat(64) }];
const content = renderMap({
  directories: [{ path: 'src', annotation: 'The application source.', groundedIn: evidence }],
  domains: [{ id: 'startup', title: 'Startup', files: [{ path: 'src/main.ts', annotation: 'Starts the application.', groundedIn: evidence }] }],
}, repository);

const mount = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);

describe('the code map at /p/:project/knowledge/map', () => {
  it('shows the map read from one commit, links the run that wrote it, and keeps the provenance block out of the page', () => {
    mount(<CodeMapPanel base="/p/proj_1" pending={false} error={null}
      map={{ revision: 'rev_1', content, repository, sourceRunId: 'run_map', generatedAt: Date.now() - 60_000 }} />);
    const panel = screen.getByTestId('repository-map');
    expect(panel.textContent).toContain('Where things live');
    expect(panel.textContent).toContain('main @ a1b2c3d4');
    expect(panel.textContent).toContain('Starts the application.');
    expect(panel.textContent).toContain('Startup');
    expect(panel.textContent).not.toContain('Map Provenance');
    expect(screen.getByRole('link', { name: /The run that wrote it/ }).getAttribute('href')).toBe('/p/proj_1/work/runs/run_map');
  });

  it('says how a map appears when the project has none, and names the task that writes one', () => {
    mount(<CodeMapPanel base="/p/proj_1" pending={false} error={null} map={null} />);
    const panel = screen.getByTestId('repository-map');
    expect(panel.textContent).toContain('No map yet');
    const task = STARTABLE_TASKS.find((entry) => entry.task === 'canopy-map');
    expect(task).toBeDefined();
    expect(panel.textContent).toContain(task!.label);
  });

  it('says the read failed rather than showing an empty map', () => {
    mount(<CodeMapPanel base="/p/proj_1" pending={false} error={new Error('boom')} map={null} />);
    expect(screen.getByTestId('repository-map').textContent).toContain('Could not load the code map.');
  });
});

describe('the code map page', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('is Knowledge\'s code map tab at /p/:project/knowledge/map, with Knowledge current in the nav, and reads the project\'s map', async () => {
    const asked: string[] = [];
    const routes: Record<string, () => Response> = {
      '/auth/me': () => Response.json({ sub: '1', login: 'ada', member: { id: 'mem_1', label: 'Ada', role: 'admin' } }),
      '/api/projects': () => Response.json({ projects: [{ projectId: 'proj_1', name: 'Myco', createdAt: 0, sessionCount: 1, lastActivityAt: null, archivedAt: null, archivedBy: null }] }),
      '/api/projects/proj_1/canopy-map': () => Response.json({ map: { revision: 'rev_1', content, repository, sourceRunId: 'run_map', generatedAt: Date.now() - 60_000 } }),
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const { pathname } = new URL(href, 'https://s');
      asked.push(pathname);
      return routes[pathname]?.() ?? new Response(null, { status: 404 });
    }) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={['/p/proj_1/knowledge/map']}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Knowledge sections' });
    expect([...tabs.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent)).toEqual(['Code map']);
    expect((await screen.findByTestId('repository-map')).textContent).toContain('Starts the application.');
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    expect([...nav.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent)).toEqual(['Knowledge']);
    expect(asked).toContain('/api/projects/proj_1/canopy-map');
  });
});
