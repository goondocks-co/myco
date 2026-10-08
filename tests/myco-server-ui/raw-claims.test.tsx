import { dashboardMe } from '../helpers/dashboard-permissions';
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RawClaimPreview } from '@goondocks/myco-shared/raw-claims';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { formatDateTime } from '../../packages/myco-server/ui/src/lib/format';

(window.Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView ??= () => undefined;
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const LABEL = 'Claim raw data with no recorded uploader';
const OWNER = 'mem_owner';
const DATE = Date.UTC(2026, 9, 1);
const PREVIEW: RawClaimPreview = { revision: 'reviewed-r1', complete: true, projects: [{ projectId: 'proj_old', name: 'Archive', kinds: [
  { kind: 'blob', count: 2, oldestAt: DATE, newestAt: DATE + 86_400_000 },
  { kind: 'event', count: 3, oldestAt: null, newestAt: null },
  { kind: 'transcript', count: 1, oldestAt: DATE, newestAt: DATE },
] }] };

function deployment(options: { owner?: boolean; role?: 'admin' | 'member'; viewerLabel?: string | null; login?: string; preview?: () => RawClaimPreview; claim?: (body: unknown) => Response; ownership?: (init?: RequestInit) => Response; roleChange?: (body: unknown) => Response; held?: boolean } = {}) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://s');
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? null : JSON.parse(String(init.body));
    requests.push({ method, path: url.pathname, body });
    switch (url.pathname) {
      case '/auth/me': return Response.json(dashboardMe({ sub: '1', login: options.login ?? 'Ada', owner: options.owner ?? true, member: { id: OWNER, label: options.viewerLabel === undefined ? 'Ada' : options.viewerLabel, role: options.role ?? 'admin' } }));
      case '/api/projects': return Response.json({ projects: [] });
      case '/api/members': return Response.json({ members: [
        { id: OWNER, label: options.viewerLabel === undefined ? 'Ada' : options.viewerLabel, role: 'admin', roleRevision: 'ada-r1', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
        { id: 'mem_member', label: 'Lin', role: 'member', roleRevision: 'lin-r1', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
        { id: 'mem_not_linked', label: 'Unlinked', role: 'admin', roleRevision: 'unlinked-r1', linked: false, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
        { id: 'mem_system', label: 'Myco', system: true, role: 'admin', roleRevision: 'system-r1', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
        ...(options.held ? [{ id: 'mem_held', label: 'Sam', role: 'admin', roleRevision: 'sam-r3', linked: true, createdAt: 0, revokedAt: 5, revokedBy: 'foreign-lineage-restore', awaitingAdmission: true, liveCredentials: 0 }] : []),
      ] });
      case '/api/enrollment': return Response.json({ invitations: [] });
      case '/api/credentials': return Response.json({ rows: [], cursor: null });
      case '/api/machines': return Response.json({ machines: [], cursor: null });
      case '/api/ownership': return options.ownership?.(init) ?? Response.json({ ownerMemberId: OWNER, revision: 'owner-r1', candidates: [{ memberId: OWNER, label: 'Ada', role: 'admin', roleRevision: 'ada-r1' }], proposalMemberId: null });
      case '/api/ownership/transfer': return options.ownership?.(init) ?? Response.json({ ownerMemberId: 'mem_next', revision: 'owner-r2', candidates: [], proposalMemberId: null });
      case '/api/members/mem_member/role': return options.roleChange?.(body) ?? Response.json({ memberId: 'mem_member', role: 'admin', roleRevision: 'lin-r2' });
      case '/api/members/mem_held/role': return Response.json({ memberId: 'mem_held', role: 'admin', roleRevision: 'sam-r4' });
      case '/api/members/mem_not_linked/role': return options.roleChange?.(body) ?? Response.json({ memberId: 'mem_not_linked', role: 'member', roleRevision: 'unlinked-r2' });
      case '/api/raw-claims': return method === 'POST' ? options.claim?.(body) ?? Response.json({ claimId: 'claim_one', preview: { revision: 'claimed-r2', complete: true, projects: [] } }) : Response.json(options.preview?.() ?? PREVIEW);
      default: return new Response(null, { status: 404 });
    }
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={['/people']}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
  return { requests, client };
}

describe('owner raw claims', () => {
  it('shows every reviewed project, kind, count and full date in a compact confirmation list', async () => {
    const preview: RawClaimPreview = { ...PREVIEW, projects: [...PREVIEW.projects, { projectId: 'proj_second', name: 'Second archive', kinds: [
      { kind: 'blob', count: 7, oldestAt: DATE, newestAt: DATE + 86_400_000 },
    ] }] };
    deployment({ preview: () => preview });
    fireEvent.click(await screen.findByRole('button', { name: LABEL }));
    const dialog = screen.getByRole('dialog');
    const list = within(dialog).getByRole('list', { name: 'Raw data claim preview' });
    expect(within(dialog).queryByRole('table')).toBeNull();
    expect(within(list).getAllByText('Archive')).toHaveLength(3);
    expect(within(list).getByText('Second archive')).toBeTruthy();
    for (const project of preview.projects) for (const kind of project.kinds) {
      const names = { blob: 'Raw blobs', event: 'Capture events', transcript: 'Transcripts' };
      const at = (value: number | null) => value === null ? 'Unknown' : formatDateTime(value);
      expect(within(list).getByText(`${names[kind.kind]} · Count: ${kind.count} · Oldest: ${at(kind.oldestAt)} · Newest: ${at(kind.newestAt)}`)).toBeTruthy();
    }
    expect(within(dialog).getByRole('button', { name: LABEL }).hasAttribute('disabled')).toBe(true);
  });

  it('previews project, all kinds, counts and dates and requires an explicitly reviewed revision', async () => {
    const { requests, client } = deployment();
    client.setQueryData(['transcript', 'proj_old', 'session_one'], { transcript: [] });
    await screen.findByRole('button', { name: LABEL });
    const table = screen.getByRole('table', { name: 'Raw data with no recorded uploader' });
    expect(within(table).getAllByText('Archive')).toHaveLength(3);
    for (const name of ['Raw blobs', 'Capture events', 'Transcripts', '2', '3', '1']) expect(within(table).getByText(name)).toBeTruthy();
    expect(within(table).getAllByText('Unknown')).toHaveLength(2);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: LABEL });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(confirm);
    await screen.findByText('The reviewed raw data is now private to you.');
    expect(requests.filter((r) => r.method === 'POST')).toEqual([{ method: 'POST', path: '/api/raw-claims', body: { revision: 'reviewed-r1' } }]);
    expect(client.getQueryState(['transcript', 'proj_old', 'session_one'])?.isInvalidated).toBe(true);
  });

  it.each(['admin', 'member'] as const)('keeps preview and action absent for a nonowner %s', async (role) => {
    const { requests } = deployment({ owner: false, role });
    await screen.findByRole('heading', { name: 'People & machines', level: 1 });
    await waitFor(() => expect(screen.queryByRole('button', { name: LABEL })).toBeNull());
    expect(requests.filter((r) => r.path === '/api/raw-claims')).toHaveLength(0);
  });

  it('disables claiming while provenance checks are incomplete', async () => {
    const { requests } = deployment({ preview: () => ({ ...PREVIEW, complete: false }) });
    const button = await screen.findByRole('button', { name: LABEL });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Uploader checks are still running. Claiming is available when they finish.')).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('posts the revision displayed in the dialog despite a background refresh', async () => {
    let preview = PREVIEW;
    const { requests, client } = deployment({ preview: () => preview });
    fireEvent.click(await screen.findByRole('button', { name: LABEL }));
    preview = { ...PREVIEW, revision: 'unreviewed-r2' };
    await client.invalidateQueries({ queryKey: ['raw-claims'] });
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: LABEL }));
    await screen.findByText('The reviewed raw data is now private to you.');
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ revision: 'reviewed-r1' });
  });

  it('requires a fresh review after a stale revision refusal and surfaces the failure', async () => {
    let preview = PREVIEW;
    const { requests } = deployment({ preview: () => preview, claim: () => {
      preview = { ...PREVIEW, revision: 'fresh-r2' };
      return Response.json({ error: 'revision_conflict' }, { status: 409 });
    } });
    fireEvent.click(await screen.findByRole('button', { name: LABEL }));
    let dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: LABEL }));
    await screen.findByText('The raw data changed. Review the refreshed preview before claiming it.');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: LABEL }).hasAttribute('disabled')).toBe(true);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });
});

describe('explicit initial ownership', () => {
  it.each([
    { label: null, login: 'Ada', name: 'Ada' },
    { label: OWNER, login: '', name: 'You' },
  ])('uses the signed-in person name for a sole-admin proposal with label $label', async ({ label, login, name }) => {
    const { requests } = deployment({ owner: false, viewerLabel: label, login, ownership: () => Response.json({ ownerMemberId: null, revision: 'owner-r1', candidates: [
      { memberId: OWNER, label, role: 'admin', roleRevision: 'ada-r1' },
    ], proposalMemberId: OWNER }) });
    expect(await screen.findByText(`Proposed server owner: ${name}. Review and confirm this choice; ownership has not changed.`)).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: 'Server owner' }));
    fireEvent.click(await screen.findByRole('option', { name }));
    fireEvent.click(screen.getByRole('button', { name: 'Record server owner' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(`Record ${name} as this server’s owner.`)).toBeTruthy();
    expect(document.body.textContent).not.toContain(OWNER);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('shows a sole eligible admin as a proposal that still needs review and confirmation', async () => {
    const { requests } = deployment({ owner: false, ownership: () => Response.json({ ownerMemberId: null, revision: 'owner-r1', candidates: [
      { memberId: OWNER, label: 'Ada', role: 'admin', roleRevision: 'ada-r1' },
    ], proposalMemberId: OWNER }) });
    expect(await screen.findByText('Proposed server owner: Ada. Review and confirm this choice; ownership has not changed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Record server owner' }).hasAttribute('disabled')).toBe(true);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('surfaces a refused bootstrap when another admin recorded an owner during review', async () => {
    let ownerMemberId: string | null = null;
    const { requests } = deployment({ owner: false, ownership: (init) => {
      if (init?.method === 'POST') { ownerMemberId = 'mem_other'; return Response.json({ error: 'revision_conflict' }, { status: 409 }); }
      return Response.json({ ownerMemberId, revision: ownerMemberId === null ? 'owner-r1' : 'owner-r2', candidates: [{ memberId: OWNER, label: 'Ada', role: 'admin', roleRevision: 'ada-r1' }], proposalMemberId: ownerMemberId === null ? OWNER : null });
    } });
    await screen.findByRole('button', { name: 'Record server owner' });
    fireEvent.click(screen.getByRole('combobox', { name: 'Server owner' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Ada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record server owner' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record server owner' }));
    await screen.findByText(/A server owner is recorded/);
    expect(screen.getByText('Ownership changed. Review the refreshed owner and choose again.').closest('[role="alert"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record server owner' })).toBeNull();
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('offers only live linked human admins and requires confirmation before recording the selected person', async () => {
    const { requests } = deployment({ owner: false, ownership: (init) => Response.json({ ownerMemberId: init?.method === 'POST' ? OWNER : null, revision: 'owner-r1', candidates: [{ memberId: OWNER, label: 'Ada', role: 'admin', roleRevision: 'ada-r1' }], proposalMemberId: OWNER }) });
    const button = await screen.findByRole('button', { name: 'Record server owner' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('combobox', { name: 'Server owner' }));
    const option = await screen.findByRole('option', { name: 'Ada' });
    expect(screen.queryByRole('option', { name: 'Lin' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Unlinked' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Myco' })).toBeNull();
    fireEvent.click(option);
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Record server owner' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(confirm);
    await waitFor(() => expect(requests.filter((r) => r.method === 'POST')).toEqual([{ method: 'POST', path: '/api/ownership', body: { ownerMemberId: OWNER, revision: 'owner-r1' } }]));
  });

  it('lets only the owner transfer to a connected admin after explicit confirmation', async () => {
    const { requests } = deployment({ ownership: (init) => Response.json({ ownerMemberId: init?.method === 'POST' ? 'mem_next' : OWNER, revision: 'owner-r1', candidates: [
      { memberId: OWNER, label: 'Ada', role: 'admin', roleRevision: 'ada-r1' },
      { memberId: 'mem_next', label: 'Next', role: 'admin', roleRevision: 'next-r1' },
    ], proposalMemberId: null }) });
    const button = await screen.findByRole('button', { name: 'Transfer server ownership' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('combobox', { name: 'New server owner' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Next' }));
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/You will remain an admin and lose owner powers/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer ownership' }));
    await waitFor(() => expect(requests.filter((r) => r.path === '/api/ownership/transfer' && r.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/ownership/transfer', body: { member_id: 'mem_next', expected_revision: 'owner-r1' } },
    ]));
  });

  it('owner confirms role promotion using the reviewed member revision', async () => {
    const { requests } = deployment();
    fireEvent.keyDown(await screen.findByRole('button', { name: 'More for Lin' }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Make admin' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Make admin' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make admin' }));
    await waitFor(() => expect(requests.filter((r) => r.path === '/api/members/mem_member/role' && r.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/members/mem_member/role', body: { member_id: 'mem_member', role: 'admin', expected_revision: 'lin-r1' } },
    ]));
  });

  it('lists a person a restore from another server held apart from the members, and lets only the owner re-admit them in their role', async () => {
    const { requests } = deployment({ held: true });
    const held = await screen.findByRole('list', { name: 'Waiting to be re-admitted' });
    expect(held.textContent).toContain('Sam');
    expect(held.textContent).toContain('can’t sign in until the owner re-admits them');
    expect(within(await screen.findByRole('list', { name: 'Members' })).queryByText('Sam')).toBeNull();
    fireEvent.click(within(held).getByRole('button', { name: 'Re-admit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Re-admit Sam?' });
    expect(dialog.textContent).toContain('as an admin');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Re-admit' }));
    await waitFor(() => expect(requests.filter((r) => r.path === '/api/members/mem_held/role' && r.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/members/mem_held/role', body: { member_id: 'mem_held', role: 'admin', expected_revision: 'sam-r3' } },
    ]));
  });

  it('shows a held person to a nonowner admin without the re-admit action', async () => {
    deployment({ owner: false, held: true });
    const held = await screen.findByRole('list', { name: 'Waiting to be re-admitted' });
    expect(within(held).queryByRole('button', { name: 'Re-admit' })).toBeNull();
  });

  it('shows roles read-only to an ordinary member through the People route', async () => {
    const { requests } = deployment({ owner: false, role: 'member' });
    const people = await screen.findByRole('list', { name: 'Members' });
    expect(within(people).getByText('Member')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'People & machines' })).toBeTruthy();
    expect(within(people).queryByRole('button', { name: /More for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Transfer server ownership' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite a teammate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a machine' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Open invitations' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Myco’s runs' })).toBeNull();
    expect(requests.some((request) => ['/api/enrollment', '/api/machines', '/api/credentials', '/api/ownership'].includes(request.path))).toBe(false);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('shows roles read-only to a nonowner admin', async () => {
    const { requests } = deployment({ owner: false });
    expect(await screen.findByRole('button', { name: 'Invite a teammate' })).toBeTruthy();
    fireEvent.keyDown(await screen.findByRole('button', { name: 'More for Lin' }), { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Make admin' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Remove' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Add a machine for them' })).toBeTruthy();
    fireEvent.keyDown(menu, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'More for Unlinked' }), { key: 'Enter' });
    expect(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Connect GitHub' })).toBeTruthy();
    expect(screen.getByText('Member')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Transfer server ownership' })).toBeNull();
    expect(requests.some((request) => request.path === '/api/ownership')).toBe(true);
  });

  it('owner can review an admin demotion but cannot demote or remove themselves', async () => {
    const { requests } = deployment();
    fireEvent.keyDown(await screen.findByRole('button', { name: 'More for Ada' }), { key: 'Enter' });
    let menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Make member' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Remove' })).toBeNull();
    fireEvent.keyDown(menu, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'More for Unlinked' }), { key: 'Enter' });
    menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Make member' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('They will lose server administration powers. Their membership and data stay.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make member' }));
    await waitFor(() => expect(requests.filter((r) => r.path === '/api/members/mem_not_linked/role' && r.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/members/mem_not_linked/role', body: { member_id: 'mem_not_linked', role: 'member', expected_revision: 'unlinked-r1' } },
    ]));
  });
});
