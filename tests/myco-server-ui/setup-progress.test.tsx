import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Projects } from '../../packages/myco-server/ui/src/pages/Projects';
import { LIVE_REFRESH_MS } from '../../packages/myco-server/ui/src/hooks/use-work';
import { GetStarted } from '../../packages/myco-server/ui/src/features/today/GetStarted';
import type { SetupProgress } from '../../packages/myco-server/ui/src/features/today/wire';
import { dashboardMe } from '../helpers/dashboard-permissions';

const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); localStorage.clear(); globalThis.setInterval = originalSetInterval; globalThis.fetch = originalFetch; });
const empty: SetupProgress = { ownerLinked: true, viewerIsOwner: true, signInWorking: true, machines: { signedIn: 0 },
  projects: 0, liveCapture: false, runnersReady: 0, workProduced: false, legacyWorkers: 0, queuedWithoutRunner: false };
function mount(role: 'admin' | 'member' = 'admin', answer: () => Response = () => Response.json(empty), projects = false) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://s'); asked.push(url.pathname);
    if (url.pathname === '/api/projects') return Response.json({ projects: [] });
    if (url.pathname === '/api/members') return Response.json({ members: [] });
    return url.pathname === '/auth/me' ? Response.json(dashboardMe({ owner: role === 'admin', member: { id: 'viewer', role } })) : answer();
  }) as typeof fetch;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[projects ? '/projects' : '/']}>{projects ? <Projects /> : <GetStarted />}</MemoryRouter></QueryClientProvider>);
  return { asked, view };
}
const item = (id: string) => document.querySelector(`[data-setup-item="${id}"]`)!;

describe('Get started checklist', () => {
  it('reads setup once and identifies done, next and later with existing commands', async () => {
    const { asked } = mount(); await waitFor(() => expect(item('machine').getAttribute('data-state')).toBe('next'));
    expect(item('owner').getAttribute('data-state')).toBe('done');
    expect(item('sign-in').getAttribute('data-state')).toBe('done');
    expect(item('project').getAttribute('data-state')).toBe('later');
    expect(item('runner').textContent).toContain(`myco setup --runner ${window.location.origin}`);
    expect(item('machine').textContent).toContain(`myco setup --join ${window.location.origin}`);
    expect(item('project').textContent).toContain('myco member join');
    expect(item('work').textContent).toContain('last 31 days');
    expect(asked.filter(path => path === '/api/setup')).toHaveLength(1);
    expect(within(item('runner') as HTMLElement).getByRole('link').getAttribute('href')).toBe('/runners');
  });

  it('combines the member’s project and capture into one actionable item with no fleet details', async () => {
    mount('member', () => Response.json({ ...empty, viewerIsOwner: false, runnersReady: null, legacyWorkers: null, queuedWithoutRunner: true }));
    await waitFor(() => expect(item('machine').getAttribute('data-state')).toBe('next'));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(item('project-capture').textContent).toContain('Start a session in your agent in that repository');
    expect(document.querySelector('[data-setup-item="runner"]')).toBeNull();
    expect(screen.getByText(/Myco’s work runs on machines an admin chooses/)).toBeTruthy();
    expect(screen.getByText(/Work is waiting for an admin/)).toBeTruthy();
  });

  it('uses owner-linked wording for an admin who is not the owner', async () => {
    mount('admin', () => Response.json({ ...empty, viewerIsOwner: false }));
    expect(await screen.findByText('Owner linked')).toBeTruthy();
    expect(screen.queryByText('You’re the owner')).toBeNull();
  });

  it('warns about queued work and names the older setup without marking it ready', async () => {
    mount('admin', () => Response.json({ ...empty, legacyWorkers: 2, queuedWithoutRunner: true }));
    await waitFor(() => expect(item('runner').textContent).toContain('older setup'));
    expect(item('runner').querySelector('[data-tone="warn"]')).toBeTruthy();
    expect(item('runner').getAttribute('data-state')).toBe('later');
  });

  it('marks every item unchecked on a failed read, then retries from live state', async () => {
    let failed = true; mount('admin', () => failed ? new Response(null, { status: 503 }) : Response.json(empty));
    expect(await screen.findByText('Couldn’t check just now.')).toBeTruthy();
    expect([...document.querySelectorAll('[data-setup-item]')].every(row => row.getAttribute('data-state') === 'unchecked')).toBe(true);
    failed = false; fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(item('machine').getAttribute('data-state')).toBe('next'));
  });

  it('does not keep green ticks when a refresh fails or an observation changes', async () => {
    let answer = { ...empty, ownerLinked: false, machines: { signedIn: 1 }, projects: 1, liveCapture: true, runnersReady: 1, workProduced: true };
    let failed = false;
    mount('admin', () => failed ? new Response(null, { status: 503 }) : Response.json(answer));
    await waitFor(() => expect(item('capture').getAttribute('data-state')).toBe('done'));
    failed = true;
    await client.invalidateQueries({ queryKey: ['setup-progress'] });
    await waitFor(() => expect(item('capture').getAttribute('data-state')).toBe('unchecked'));
    expect(item('runner').getAttribute('data-state')).toBe('unchecked');
    failed = false;
    answer = { ...answer, ownerLinked: true, liveCapture: false, runnersReady: 0, workProduced: false };
    await client.invalidateQueries({ queryKey: ['setup-progress'] });
    await waitFor(() => expect(item('capture').getAttribute('data-state')).toBe('next'));
    expect(item('runner').getAttribute('data-state')).toBe('later');
  });

  it('hides for this browser without persisting progress', async () => {
    const { view } = mount(); await screen.findByText('You’re the owner');
    fireEvent.click(screen.getByRole('button', { name: 'Hide for now' }));
    expect(screen.queryByText('Get started')).toBeNull();
    expect(localStorage.length).toBe(1);
    view.unmount(); mount(); expect(screen.queryByText('Get started')).toBeNull();
  });
  for (const role of ['admin', 'member'] as const) it(`retires an all-done ${role} checklist and stops polling`, async () => {
    globalThis.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
      originalSetInterval(handler, ms === LIVE_REFRESH_MS ? 10 : ms, ...args)) as typeof setInterval;
    const { asked } = mount(role, () => Response.json({ ...empty, machines: { signedIn: 1 }, projects: 1,
      liveCapture: true, runnersReady: role === 'admin' ? 1 : null, workProduced: role === 'admin' }));
    await waitFor(() => expect(asked.filter(path => path === '/api/setup')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Get started' })).toBeNull());
    await Bun.sleep(45);
    expect(asked.filter(path => path === '/api/setup')).toHaveLength(1);
  });

  it('does not ask setup while hidden and restores it from the Projects empty state', async () => {
    localStorage.setItem('myco:get-started:hidden', 'yes');
    const { asked } = mount('admin', () => Response.json(empty), true);
    expect(await screen.findByText('No projects yet.')).toBeTruthy();
    expect(asked).not.toContain('/api/setup');
    fireEvent.click(screen.getByRole('button', { name: 'Show Get started' }));
    await waitFor(() => expect(item('machine').getAttribute('data-state')).toBe('next'));
    expect(localStorage.getItem('myco:get-started:hidden')).toBeNull();
    expect(asked.filter(path => path === '/api/setup')).toHaveLength(1);
    expect(within(item('project') as HTMLElement).queryByRole('link', { name: 'Projects' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hide for now' }));
    expect(screen.getByText('No projects yet.')).toBeTruthy();
  });

  it('does not ask setup after a hidden browser visit', async () => {
    localStorage.setItem('myco:get-started:hidden', 'yes');
    const { asked } = mount();
    await waitFor(() => expect(asked).toContain('/auth/me'));
    await Bun.sleep(45);
    expect(asked).not.toContain('/api/setup');
  });

  it('keeps the checklist usable when the storage getter throws', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    try {
      mount(); await waitFor(() => expect(item('machine').getAttribute('data-state')).toBe('next'));
      fireEvent.click(screen.getByRole('button', { name: 'Hide for now' }));
      expect(screen.queryByRole('heading', { name: 'Get started' })).toBeNull();
    } finally { Object.defineProperty(globalThis, 'localStorage', descriptor); }
  });

  it('keeps dismissal working when storage writes are refused', async () => {
    const write = spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    try {
      mount(); await screen.findByText('You’re the owner');
      fireEvent.click(screen.getByRole('button', { name: 'Hide for now' }));
      expect(screen.queryByRole('heading', { name: 'Get started' })).toBeNull();
    } finally { write.mockRestore(); }
  });

});

it('keeps the checklist actionable when enabled code work still needs source', async () => {
  mount('admin', () => Response.json({ ...empty, machines: { signedIn: 1 }, projects: 1, liveCapture: true,
    runnersReady: 1, workProduced: true, repositoriesNeeded: [{ projectId: 'proj_code' }] }));
  await waitFor(() => expect(item('repository:proj_code')).not.toBeNull());
  expect(item('repository:proj_code').textContent).toContain('Connect this project’s repository so Myco can map its code');
  expect(item('repository:proj_code').textContent).toContain('Code tasks are turned on, but they cannot run until a repository is connected.');
  expect(within(item('repository:proj_code') as HTMLElement).getByRole('link', { name: 'Connect repository' }).getAttribute('href'))
    .toBe('/p/proj_code/settings?connect=repository#repository');
});
