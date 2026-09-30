/**
 * A project's settings: what Myco does there, the repository its code tasks
 * read, the access keys agents outside this server read it with, and release
 * tracking. Every change that ends something is confirmed from a menu, a key
 * is shown once, and a refusal stays in view.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { keyWords } from '../../packages/myco-server/ui/src/features/admin/project/access-keys';
import { rawIdsIn } from '../helpers/raw-ids';

const ADA = 'mem_q3Vb8xRk2LmT7wYz';
const LIN = 'mem_Hn5-pC0dJfA9sE_u';
const P = 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11';
const ADMIN = { sub: '1', login: 'ada', member: { id: ADA, label: 'Ada', role: 'admin' as const } };
const MEMBER = { sub: '2', login: 'lin', member: { id: LIN, label: LIN, role: 'member' as const } };
const NOW = Date.now();
const HOUR = 3_600_000;
const PROJECTS = { projects: [{ projectId: P, name: 'Myco', createdAt: 0, sessionCount: 3, lastActivityAt: NOW, archivedAt: null, archivedBy: null }] };
const MEMBERS = { members: [
  { id: ADA, label: 'Ada', role: 'admin', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
  { id: LIN, label: LIN, role: 'member', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
] };
const grant = (over: Record<string, unknown> = {}) => ({
  id: 'eg_live1', projectId: P, label: 'review bot', createdBy: ADA, createdAt: NOW - 3 * 24 * HOUR, expiresAt: null,
  lastUsedAt: NOW - 2 * HOUR, revokedAt: null, revokedBy: null, rotatedTo: null, ...over,
});
const REPOSITORY = {
  revision: 'rev_7', url: 'https://github.com/goondocks-co/myco.git', branch: 'main', username: 'x-access-token',
  credential: { configured: true, readable: true, maskedValue: 'g…x', updatedAt: NOW, updatedBy: ADA }, updatedAt: NOW - HOUR, updatedBy: ADA,
};
const RELEASES = {
  enabled: false, githubRepo: null, productionRefs: [], integrationRefs: [], packageMap: [], includeUnknown: false, maxLookups: 50,
  revision: null, updatedAt: null, updatedBy: null, credential: { configured: false, purpose: 'Reads release tags for this project.' },
  suggestedRepo: 'goondocks-co/myco', check: null, problem: null,
};

interface Sent { method: string; path: string; body: unknown }
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(routes: Record<string, (init?: RequestInit) => Response>): { sent: Sent[]; asked: string[] } {
  const sent: Sent[] = [];
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(href, 'https://s').pathname;
    const method = init?.method ?? 'GET';
    asked.push(`${method} ${pathname}`);
    if (method !== 'GET') sent.push({ method, path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return routes[`${method} ${pathname}`]?.(init) ?? routes[pathname]?.(init) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { sent, asked };
}

const api = `/api/projects/${P}`;
const base = (extra: Record<string, (init?: RequestInit) => Response> = {}) => ({
  '/auth/me': () => Response.json(ADMIN),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/members': () => Response.json(MEMBERS),
  '/api/status': () => Response.json({ target: 'bun' }),
  [`${api}/capabilities`]: () => Response.json({ capabilities: { cortex: true, canopy: false, skills: false, vault_evolution: true } }),
  [`${api}/repository`]: () => Response.json({ repository: REPOSITORY }),
  [`${api}/grants`]: () => Response.json({ grants: [grant(), grant({ id: 'eg_old', label: 'old bot', revokedAt: NOW - HOUR, revokedBy: ADA, rotatedTo: 'eg_live1' })] }),
  [`${api}/release-provenance`]: () => Response.json({ releaseProvenance: RELEASES }),
  ...extra,
});

function Where() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.hash}`}</span>;
}

function mount(path: string) {
  const proto = window.HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
  proto.scrollIntoView ??= () => undefined;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /><Where /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

const sectionOf = (id: string) => document.getElementById(id) as HTMLElement;
async function openMenu(name: string) {
  fireEvent.keyDown(await screen.findByRole('button', { name }), { key: 'Enter' });
  return screen.findByRole('menu');
}

describe('a project\'s settings', () => {
  it('holds what Myco does there, the repository, the access keys and release tracking, in that order, naming the project and never an id', async () => {
    server(base());
    mount(`/p/${P}/settings`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Project settings' })).toBeTruthy();
    // The page reads its project's name beside its own reads, and names it once the projects arrive.
    await waitFor(() => expect(document.body.textContent).toContain('How Myco works in Myco:'));
    const headings = await waitFor(() => {
      const found = [...document.querySelectorAll('[data-admin-page="project-settings"] h2')].map((h) => h.textContent);
      expect(found).toHaveLength(4);
      return found;
    });
    expect(headings).toEqual(['What Myco does here', 'Repository', 'Access keys', 'Release tracking']);
    expect(['capabilities', 'repository', 'access-keys', 'release-tracking'].every((id) => sectionOf(id) !== null)).toBe(true);
    await screen.findByText('review bot');
    await screen.findByText('https://github.com/goondocks-co/myco.git');
    expect(rawIdsIn(document.body, ['[data-testid="location"]'])).toEqual([]);
  });

  it('leaves out the skills switch, which nothing reads, and shows it read-only under Older only while it is on', async () => {
    server(base());
    mount(`/p/${P}/settings`);
    expect(await screen.findByRole('switch', { name: 'Learning' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Skills' })).toBeNull();
    expect(within(sectionOf('capabilities')).queryByRole('button', { name: 'Older' })).toBeNull();
    cleanup();
    const { sent } = server(base({ [`${api}/capabilities`]: () => Response.json({ capabilities: { cortex: true, canopy: false, skills: true, vault_evolution: true } }) }));
    mount(`/p/${P}/settings`);
    await screen.findByRole('switch', { name: 'Learning' });
    fireEvent.click(within(sectionOf('capabilities')).getByRole('button', { name: 'Older' }));
    const skills = await screen.findByRole('switch', { name: 'Skills' });
    expect((skills as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(skills);
    expect(sent).toEqual([]);
  });

  it('switches a capability through the project route, and says why when the server refuses', async () => {
    let refuse = false;
    const { sent } = server(base({ [`PUT ${api}/capabilities/canopy`]: () => (refuse ? Response.json({ error: 'nope' }, { status: 503 }) : Response.json({ applied: true })) }));
    mount(`/p/${P}/settings`);
    const map = await screen.findByRole('switch', { name: 'Code map' });
    expect(map.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(map);
    await waitFor(() => expect(sent).toEqual([{ method: 'PUT', path: `${api}/capabilities/canopy`, body: { enabled: true } }]));
    refuse = true;
    fireEvent.click(screen.getByRole('switch', { name: 'Code map' }));
    expect((await within(sectionOf('capabilities')).findByRole('alert')).textContent).toBe('The server refused (503).');
  });

  it('a member is told the page is for an admin, and nothing an admin reads is asked', async () => {
    const { asked } = server(base({ '/auth/me': () => Response.json(MEMBER) }));
    mount(`/p/${P}/settings`);
    expect(await screen.findByTestId('admin-only')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked.filter((line) => line.includes(`${api}/`))).toEqual([]);
  });

  it('leads the project\'s old access address to its access keys', async () => {
    server(base());
    mount(`/p/${P}/access`);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/p/${P}/settings#access-keys`));
  });
});

describe('the repository', () => {
  it('shows what is connected and how, never the credential, and edits it with the credential kept', async () => {
    const { sent } = server(base({ [`PUT ${api}/repository`]: () => Response.json({ repository: REPOSITORY }) }));
    mount(`/p/${P}/settings`);
    const section = await waitFor(() => { const s = sectionOf('repository'); expect(s.textContent).toContain('main'); return s; });
    expect(section.textContent).toContain('With a read-only token');
    expect(section.textContent).toContain('1 h ago by Ada');
    expect(section.textContent).not.toContain('g…x');
    fireEvent.click(within(section).getByRole('button', { name: 'Edit repository' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Read token') as HTMLInputElement).placeholder).toBe('Leave blank to keep the current token');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save repository' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: 'PUT', path: `${api}/repository`, body: { url: REPOSITORY.url, branch: 'main', revision: 'rev_7' } });
  });

  it('connects a public repository with no credential', async () => {
    const { sent } = server(base({
      [`GET ${api}/repository`]: () => Response.json({ repository: null }),
      [`PUT ${api}/repository`]: () => Response.json({ repository: REPOSITORY }),
    }));
    mount(`/p/${P}/settings`);
    await waitFor(() => expect(sectionOf('repository').textContent).toContain('No repository connected'));
    fireEvent.click(within(sectionOf('repository')).getByRole('button', { name: 'Connect repository' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('HTTPS repository address'), { target: { value: 'https://github.com/example/app.git' } });
    expect(within(dialog).getByRole('switch', { name: 'Use without a token' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save repository' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({ url: 'https://github.com/example/app.git', branch: 'main', revision: null, credential: null });
  });

  it('disconnects only from its menu, behind a confirm that keeps a refusal in view', async () => {
    let attempts = 0;
    const { sent } = server(base({
      [`DELETE ${api}/repository`]: () => (++attempts === 1 ? Response.json({ error: 'conflict', reason: 'This changed since the page read it. Refresh before saving again.' }, { status: 409 }) : Response.json({ removed: true })),
    }));
    mount(`/p/${P}/settings`);
    await waitFor(() => expect(sectionOf('repository').textContent).toContain('main'));
    expect(within(sectionOf('repository')).queryByRole('button', { name: 'Disconnect' })).toBeNull();
    fireEvent.click(within(await openMenu('More for the repository')).getByRole('menuitem', { name: 'Disconnect repository' }));
    const dialog = await screen.findByRole('dialog');
    expect(sent).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('This changed since the page read it. Refresh before saving again.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent).toEqual([
      { method: 'DELETE', path: `${api}/repository`, body: { revision: 'rev_7' } },
      { method: 'DELETE', path: `${api}/repository`, body: { revision: 'rev_7' } },
    ]);
  });
});

describe('access keys', () => {
  it('lists the live keys with when they were added, by whom and last used, and the ended ones folded away', async () => {
    server(base());
    mount(`/p/${P}/settings`);
    const section = await waitFor(() => { const s = sectionOf('access-keys'); expect(s.textContent).toContain('review bot'); return s; });
    expect(section.textContent).toContain('Added 3 days ago by Ada · last used 2 h ago');
    expect(within(section).queryByText('old bot')).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: '1 ended key' }));
    expect((await within(section).findByText('old bot')).closest('[data-access-key]')!.textContent).toContain('replaced 1 h ago by Ada');
  });

  it('adds a key and shows it once: closing forgets it, and reopening offers the form again', async () => {
    const { sent } = server(base({ [`POST ${api}/grants`]: () => Response.json({ key: `mycoext_${'x'.repeat(43)}`, id: 'eg_new' }, { status: 201 }) }));
    mount(`/p/${P}/settings`);
    fireEvent.click(await screen.findByRole('button', { name: 'Add access key' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '  docs bot ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect((await screen.findByTestId('key-once')).textContent).toBe(`mycoext_${'x'.repeat(43)}`);
    expect(screen.getByRole('dialog').textContent).toContain('/mcp');
    expect(sent).toEqual([{ method: 'POST', path: `${api}/grants`, body: { label: 'docs bot' } }]);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain('mycoext_');
    fireEvent.click(screen.getByRole('button', { name: 'Add access key' }));
    expect(await screen.findByRole('button', { name: 'Create key' })).toBeTruthy();
    expect(screen.queryByTestId('key-once')).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('says why a key was not made, in the dialog', async () => {
    server(base({ [`POST ${api}/grants`]: () => Response.json({ error: 'bad_request', reason: 'label must be printable' }, { status: 400 }) }));
    mount(`/p/${P}/settings`);
    fireEvent.click(await screen.findByRole('button', { name: 'Add access key' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create key' }));
    expect((await within(screen.getByRole('dialog')).findByRole('alert')).textContent).toBe('The server could not make that change to the key.');
    expect(screen.queryByTestId('key-once')).toBeNull();
  });

  it('rotates from the key\'s menu behind a confirm, then shows the new key once', async () => {
    const { sent } = server(base({ [`POST ${api}/grants/eg_live1/rotate`]: () => Response.json({ key: `mycoext_${'y'.repeat(43)}`, id: 'eg_live2' }, { status: 201 }) }));
    mount(`/p/${P}/settings`);
    fireEvent.click(within(await openMenu('More for review bot')).getByRole('menuitem', { name: 'Rotate key' }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm.textContent).toContain('stops working the moment the new one exists');
    expect(sent).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Rotate key' }));
    expect((await screen.findByTestId('key-once')).textContent).toBe(`mycoext_${'y'.repeat(43)}`);
    expect(screen.getByRole('dialog').textContent).toContain('New access key');
    expect(sent).toEqual([{ method: 'POST', path: `${api}/grants/eg_live1/rotate`, body: undefined }]);
  });

  it('revokes from the key\'s menu behind a confirm that keeps a refusal in view', async () => {
    let attempts = 0;
    const { sent } = server(base({ [`POST ${api}/grants/eg_live1/revoke`]: () => (++attempts === 1 ? new Response(null, { status: 503 }) : Response.json({ revoked: true })) }));
    mount(`/p/${P}/settings`);
    fireEvent.click(within(await openMenu('More for review bot')).getByRole('menuitem', { name: 'Revoke key' }));
    const confirm = await screen.findByRole('dialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke key' }));
    expect((await within(confirm).findByRole('alert')).textContent).toBe('The server refused (503).');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke key' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent.map((s) => s.path)).toEqual([`${api}/grants/eg_live1/revoke`, `${api}/grants/eg_live1/revoke`]);
  });

  it('words a key by how it stands, naming people only by name', () => {
    const names = (id: string | null) => (id === ADA ? 'Ada' : null);
    expect(keyWords(grant({ lastUsedAt: null }) as never, names, NOW)).toBe('Added 3 days ago by Ada · never used');
    expect(keyWords(grant({ createdBy: LIN, expiresAt: NOW + 3 * 24 * HOUR }) as never, names, NOW)).toBe('Added 3 days ago · last used 2 h ago · expires in 3d');
    expect(keyWords(grant({ revokedAt: NOW - HOUR, revokedBy: 'expiry' }) as never, names, NOW)).toBe('Added 3 days ago by Ada · expired 1 h ago');
    expect(keyWords(grant({ revokedAt: NOW - HOUR, revokedBy: ADA }) as never, names, NOW)).toBe('Added 3 days ago by Ada · revoked 1 h ago by Ada');
  });
});
