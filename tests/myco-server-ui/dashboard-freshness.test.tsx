import { afterEach, expect, it } from 'bun:test';
import { useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Dialog, DialogContent, Input, MoreMenu } from '../../packages/myco-server/ui/src/design';
import { LinkPage } from '../../packages/myco-server/ui/src/pages/Link';
import { MachineSettingsDialog } from '../../packages/myco-server/ui/src/features/admin/people/MachineSettingsDialog';
import { PlansBoard } from '../../packages/myco-server/ui/src/features/knowledge/PlansBoard';
import { SessionPage } from '../../packages/myco-server/ui/src/features/sessions/SessionPage';
import { SessionsPage } from '../../packages/myco-server/ui/src/features/sessions/SessionsPage';
import { useAccessActions } from '../../packages/myco-server/ui/src/hooks/use-access';
import { usePaged } from '../../packages/myco-server/ui/src/hooks/use-paged';
import { useConversationSearch } from '../../packages/myco-server/ui/src/hooks/use-conversation-search';
import { useNeedsYou } from '../../packages/myco-server/ui/src/hooks/use-needs-you';
import { useTurnCollection } from '../../packages/myco-server/ui/src/hooks/use-turn-collection';
import { useTurnToolCalls } from '../../packages/myco-server/ui/src/hooks/use-sessions';
import { holdPendingLink } from '../../packages/myco-server/ui/src/lib/pending-link';
import { dashboardMe } from '../helpers/dashboard-permissions';

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); globalThis.fetch = originalFetch; window.sessionStorage.clear(); });
function setup(answer: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(answer(new URL(String(input), 'https://local'), init))) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(['me'], dashboardMe({ member: { id: 'm', label: 'Member', role: 'member' } }));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  return { client, wrapper };
}
const empty = () => Response.json({ rows: [], cursor: null, members: [], projects: [], items: [] });
const session = { sessionId: 's', projectId: 'p', title: 'Retained session', summary: 'Saved summary', firstReceivedAt: 1, lastReceivedAt: 2, startedAt: 1, endedAt: 2, agent: null, branch: null };
const detail = () => ({ session, counts: { prompts: 0, userPrompts: 0, toolCalls: 0, failedTools: 0, mycoCalls: 0, plans: 0 }, outcome: { runs: [], spores: { total: 0, items: [] } }, turnContexts: {}, filesEdited: 0 });

it('reconciles linked membership before opening Projects', async () => {
  holdPendingLink('x'.repeat(43));
  let linked = false;
  const { client, wrapper } = setup((url, init) => {
    if (url.pathname === '/auth/me') return Response.json(dashboardMe({ member: linked ? { id: 'm', label: 'Member', role: 'member' } : null }));
    if (JSON.parse(String(init?.body)).confirm) { linked = true; return Response.json({ linked: true, member: { id: 'm', label: 'Member' } }); }
    return Response.json({ preview: { member: { id: 'm', label: 'Member' } } });
  });
  client.setQueryData(['me'], dashboardMe({ member: null }));
  render(<LinkPage />, { wrapper });
  fireEvent.click(await screen.findByRole('button', { name: 'Connect this account' }));
  await screen.findByRole('link', { name: 'Open Projects' });
  expect(client.getQueryData<{ member: unknown }>(['me'])?.member).not.toBeNull();
});

it('retains a newer folder edit while the submitted revision settles', async () => {
  let value: string[] = [];
  let finish!: () => void;
  const { wrapper } = setup((url, init) => {
    if (init?.method === 'PUT') return new Promise(resolve => { finish = () => { value = JSON.parse(String(init.body)).value; resolve(Response.json({ applied: true })); }; });
    if (url.pathname.endsWith('/settings')) return Response.json({ leaves: [{ leaf: 'capture.plan_dirs', configured: true, value, updatedAt: null, updatedBy: null }] });
    return empty();
  });
  render(<MachineSettingsDialog machine={{ id: 'mac', name: 'Local' }} onClose={() => {}} />, { wrapper });
  const add = async (folder: string) => { fireEvent.change(await screen.findByRole('textbox', { name: 'Plan folder to add' }), { target: { value: folder } }); fireEvent.click(screen.getByRole('button', { name: 'Add' })); };
  await add('plans/one');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(finish).toBeDefined());
  await add('plans/two');
  await act(async () => finish());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false));
  expect(screen.getByRole('button', { name: 'Remove plans/two' })).toBeTruthy();
});

it('refreshes an open tool list when the session revision changes', async () => {
  let calls = 0;
  const { client, wrapper } = setup(url => {
    if (url.pathname.endsWith('/tool-calls')) { calls++; return empty(); }
    return empty();
  });
  client.setQueryData(['session', 'p', 's'], detail());
  function Reader() { useTurnToolCalls('p', 's', 'turn', true); return <SessionPage projectId="p" sessionId="s" projectName="Local" />; }
  render(<Reader />, { wrapper });
  await waitFor(() => expect(calls).toBe(1));
  act(() => client.setQueryData(['session', 'p', 's'], { ...detail(), session: { ...session, lastReceivedAt: 3 } }));
  await waitFor(() => expect(calls).toBe(2));
});

it('restarts expired turn cursors after refreshing their parent', async () => {
  let parentReads = 0;
  const cursors: Array<string | null> = [];
  const initial = [{ id: 'old' }];
  const { client, wrapper } = setup(url => {
    if (!url.searchParams.has('collection')) { parentReads++; return Response.json({}); }
    cursors.push(url.searchParams.get('cursor'));
    return url.searchParams.has('cursor') ? Response.json({ error: 'stale_cursor' }, { status: 409 }) : Response.json({ rows: [{ id: 'current' }], cursor: null });
  });
  client.setQueryDefaults(['turn', 'p', 's', 'turn'], { queryFn: () => fetch('/parent').then(r => r.json()) });
  client.setQueryData(['turn', 'p', 's', 'turn'], {});
  const { result } = renderHook(() => useTurnCollection('p', 's', 'turn', 'responses', initial, 'expired', row => row.id), { wrapper });
  act(() => result.current.more());
  await waitFor(() => expect(result.current.error).toBeTruthy());
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.rows).toEqual([{ id: 'current' }]));
  expect(cursors).toEqual(['expired', null]);
  expect(parentReads).toBe(1);
});

it('keeps session data visible with the failed refresh and its retry', async () => {
  let failing = true;
  const { client, wrapper } = setup(url => url.pathname.endsWith('/sessions/s') ? failing ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(detail()) : empty());
  client.setQueryData(['session', 'p', 's'], detail());
  render(<SessionPage projectId="p" sessionId="s" projectName="Local" />, { wrapper });
  await act(async () => { await client.refetchQueries({ queryKey: ['session', 'p', 's'] }); });
  expect(screen.getByRole('heading', { name: 'Retained session' })).toBeTruthy();
  expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t refresh');
  failing = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

it('shows live-source failure and retries that source beside the session list', async () => {
  let failing = true;
  const { wrapper } = setup(url => url.searchParams.get('state') === 'open' && failing ? Response.json({ error: 'unavailable' }, { status: 503 }) : empty());
  render(<SessionsPage projectId="p" projectName={() => 'Local'} />, { wrapper });
  expect((await screen.findByRole('alert')).textContent).toContain('live sessions');
  failing = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

it('returns keyboard focus to a connected opener or the page fallback', async () => {
  function Example() {
    const [open, setOpen] = useState(false);
    const [opener, setOpener] = useState(true);
    return <><main tabIndex={-1}>Page</main>{opener && <button onClick={() => setOpen(true)}>Open</button>}<Dialog open={open} onOpenChange={setOpen}><DialogContent title="Example"><Input aria-label="Name" autoFocus /><button onClick={() => { setOpener(false); setOpen(false); }}>Remove opener</button></DialogContent></Dialog></>;
  }
  render(<Example />);
  const opener = screen.getByRole('button', { name: 'Open' });
  opener.focus(); fireEvent.click(opener);
  fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
  await waitFor(() => expect(document.activeElement === opener).toBe(true));
  fireEvent.click(opener);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove opener' }));
  await waitFor(() => expect(document.activeElement === screen.getByRole('main')).toBe(true));
});

it('retries the repository source without asking an ordinary member for admin reads', async () => {
  let reads = 0;
  let adminReads = 0;
  const { wrapper } = setup(url => {
    if (url.pathname === '/api/uncaptured') { reads++; return reads === 1 ? Response.json({ error: 'unavailable' }, { status: 503 }) : empty(); }
    if (url.pathname === '/api/attention') { adminReads++; return empty(); }
    return empty();
  });
  const { result } = renderHook(() => useNeedsYou({ now: 1, projectName: () => 'Local' }), { wrapper });
  await waitFor(() => expect(result.current.repositories.error).toBeTruthy());
  act(() => result.current.onRetry());
  await waitFor(() => expect(result.current.repositories.error).toBeNull());
  expect(reads).toBe(2);
  expect(adminReads).toBe(0);
});

it('states the plan board progress limit for large plans, whose text the board search reads in full', async () => {
  const { wrapper } = setup(() => Response.json({ plans: [], cursor: null, hasMore: false, totals: {} }));
  render(<PlansBoard projectId="p" projectName={() => 'Local'} />, { wrapper });
  expect(screen.getByText(/checklist progress is unavailable on this board for large plans/i)).toBeTruthy();
});

it('returns focus to the connected menu trigger after an autofocused dialog closes', async () => {
  function Example() {
    const [open, setOpen] = useState(false);
    return <><main tabIndex={-1}>Page</main><MoreMenu label="Row actions" items={[{ label: 'Rename', onSelect: () => setOpen(true) }]} /><Dialog open={open} onOpenChange={setOpen}><DialogContent title="Rename"><Input aria-label="Name" autoFocus /></DialogContent></Dialog></>;
  }
  render(<Example />);
  const trigger = screen.getByRole('button', { name: 'Row actions' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const item = await screen.findByRole('menuitem', { name: 'Rename' });
  item.focus(); fireEvent.keyDown(item, { key: 'Enter' });
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(document.activeElement === trigger).toBe(true));
});

it('retains committed account linking while sign-in refresh fails and retries only the read', async () => {
  holdPendingLink('x'.repeat(43));
  let posts = 0;
  let failed = true;
  const { client, wrapper } = setup((url, init) => {
    if (url.pathname === '/auth/me') return failed ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(dashboardMe({ member: { id: 'm', label: 'Member', role: 'member' } }));
    if (JSON.parse(String(init?.body)).confirm) { posts++; return Response.json({ linked: true, member: { id: 'm', label: 'Member' } }); }
    return Response.json({ preview: { member: { id: 'm', label: 'Member' } } });
  });
  client.setQueryData(['me'], dashboardMe({ member: null }));
  render(<LinkPage />, { wrapper });
  fireEvent.click(await screen.findByRole('button', { name: 'Connect this account' }));
  await waitFor(() => expect(screen.getByText(/Connected to/)).toBeTruthy());
  expect(screen.queryByRole('link', { name: 'Open Projects' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('sign-in');
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('link', { name: 'Open Projects' });
  expect(posts).toBe(1);
});

it('reconciles each access mutation and preserves write results and list invalidation on refresh failure', async () => {
  let reads = 0;
  let failing = false;
  const { client, wrapper } = setup(url => {
    if (url.pathname === '/auth/me') { reads++; return failing ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(dashboardMe({ login: String(reads), member: { id: 'm', label: 'Member', role: 'admin' } })); }
    if (url.pathname.endsWith('/role')) return Response.json({ memberId: 'other', role: 'member', roleRevision: 'next' });
    if (url.pathname.endsWith('/stop')) return Response.json({ revoked: 2, revokedBy: 'm' });
    return Response.json({ revoked: true });
  });
  const { result } = renderHook(() => useAccessActions(), { wrapper });
  const writes = [
    { run: () => result.current.revokeMember.mutateAsync('other'), expected: { revoked: true } },
    { run: () => result.current.changeRole.mutateAsync({ memberId: 'other', role: 'member', expectedRevision: 'revision' }), expected: { memberId: 'other', role: 'member', roleRevision: 'next' } },
    { run: () => result.current.revokeCredentials.mutateAsync(['a', 'b']), expected: { stopped: ['a', 'b'], failed: [] } },
    { run: () => result.current.stopMachine.mutateAsync('mac'), expected: { revoked: 2, revokedBy: 'm' } },
  ];
  for (const { run: write, expected } of writes) {
    let committed: unknown;
    await act(async () => { committed = await write(); });
    expect(client.getQueryData<{ login: string }>(['me'])?.login).toBe(String(reads));
    failing = true;
    client.setQueryData(['members'], { members: [] });
    let retained: unknown;
    await act(async () => { retained = await write(); });
    expect(committed).toEqual(expected);
    expect(retained).toEqual(expected);
    expect(client.getQueryState(['me'])?.error).toBeTruthy();
    expect(client.getQueryState(['me'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['members'])?.isInvalidated).toBe(true);
    failing = false;
  }
  expect(reads).toBe(8);
});

it('discards an expired cursor set in a generic paged session read', async () => {
  let first = true;
  let parents = 0;
  const { client, wrapper } = setup(url => {
    if (url.pathname === '/parent') { parents++; return Response.json({}); }
    if (url.searchParams.has('cursor')) return Response.json({ error: 'stale_cursor' }, { status: 409 });
    const rows = [{ id: first ? 'old' : 'current' }]; const cursor = first ? 'expired' : null; first = false;
    return Response.json({ rows, cursor });
  });
  client.setQueryDefaults(['session', 'p', 's'], { queryFn: () => fetch('/parent').then(r => r.json()) });
  client.setQueryData(['session', 'p', 's'], {});
  const { result } = renderHook(() => usePaged<{ id: string }>(['turn-tool-calls', 'p', 's', 'turn'], '/calls', { freshness: 'still' }), { wrapper });
  await waitFor(() => expect(result.current.rows).toEqual([{ id: 'old' }]));
  act(() => result.current.more());
  await waitFor(() => expect(result.current.error).toBeTruthy());
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.rows).toEqual([{ id: 'current' }]));
  expect(parents).toBe(1);
});

it('refreshes open conversation search when a session revision changes', async () => {
  let reads = 0;
  const { client, wrapper } = setup(url => {
    if (url.pathname.endsWith('/search')) { reads++; return Response.json({ results: [], cursor: null, coverage: { pending_blobs: 0 } }); }
    return empty();
  });
  client.setQueryData(['session', 'p', 's'], detail());
  function Reader() { useConversationSearch('p', 's', 'needle'); return <SessionPage projectId="p" sessionId="s" projectName="Local" />; }
  render(<Reader />, { wrapper });
  await waitFor(() => expect(reads).toBe(1));
  act(() => client.setQueryData(['session', 'p', 's'], { ...detail(), session: { ...session, lastReceivedAt: 3 } }));
  await waitFor(() => expect(reads).toBe(2));
});
