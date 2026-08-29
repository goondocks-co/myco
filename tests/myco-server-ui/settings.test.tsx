import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { LEAF_FIELDS, LEAF_GROUPS } from '../../packages/myco-server/ui/src/settings/catalogue';
import { STEP_UP_HEADER } from '../../packages/myco-server/ui/src/hooks/use-settings';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris' } };
const PROJECTS = { projects: [{ projectId: 'x', name: 'Project X', createdAt: 0, sessionCount: 0, lastActivityAt: null, archivedAt: null, archivedBy: null }] };
const NOW = Date.now();
const SECRET = 'sk-full-secret-value-1234567890';

const leaves = (over: Record<string, Partial<{ value: unknown; updatedBy: string; updatedAt: number }>> = {}) => ({
  leaves: LEAF_FIELDS.map((f) => {
    const o = over[f.leaf];
    return { leaf: f.leaf, configured: o !== undefined, value: o?.value ?? null, updatedAt: o?.updatedAt ?? null, updatedBy: o?.updatedBy ?? null, requiresStepUp: /base_url$|provider\.type$/.test(f.leaf) };
  }),
});
const secrets = (anthropicConfigured: boolean) => ({ secrets: [
  { name: 'anthropic', configured: anthropicConfigured, readable: true, maskedValue: anthropicConfigured ? 's…c' : null, updatedAt: anthropicConfigured ? NOW : null, updatedBy: anthropicConfigured ? 'mem_1' : null },
  { name: 'openai', configured: false, readable: true, maskedValue: null, updatedAt: null, updatedBy: null },
  { name: 'openrouter', configured: false, readable: true, maskedValue: null, updatedAt: null, updatedBy: null },
  { name: 'github', configured: false, readable: true, maskedValue: null, updatedAt: null, updatedBy: null },
] });

interface Sent { method: string; path: string; body: unknown; headers: Record<string, string> }
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(routes: Record<string, (init?: RequestInit) => Response>): { sent: Sent[] } {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(href, 'https://s').pathname;
    const method = init?.method ?? 'GET';
    if (method !== 'GET') sent.push({ method, path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})) });
    return routes[pathname]?.(init) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { sent };
}

const base = (extra: Record<string, (init?: RequestInit) => Response> = {}) => ({
  '/auth/me': () => Response.json(ME),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/settings': () => Response.json(leaves({ 'cortex.digest.inject_on_session_start': { value: true, updatedBy: 'mem_1', updatedAt: NOW } })),
  '/api/secrets': () => Response.json(secrets(true)),
  '/api/projects/x/capabilities': () => Response.json({ capabilities: { cortex: true, canopy: false, skills: false, vault_evolution: false } }),
  ...extra,
});

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

const tab = async (label: string) => fireEvent.click(await screen.findByRole('tab', { name: label }));

describe('Deployment Settings', () => {
  it('renders a control for every catalogued leaf across the groups, and names who saved a configured one', async () => {
    server(base());
    mount('/settings');
    await screen.findByRole('list', { name: LEAF_GROUPS[0]!.label });
    let controls = 0;
    for (const group of LEAF_GROUPS) {
      await tab(group.label);
      const list = await screen.findByRole('list', { name: group.label });
      for (const f of group.leaves) {
        expect({ leaf: f.leaf, present: within(list).queryByLabelText(f.label) !== null }).toEqual({ leaf: f.leaf, present: true });
        controls += 1;
      }
    }
    expect(controls).toBe(LEAF_FIELDS.length);
    await tab('Cortex');
    expect(screen.getByTestId('saved-cortex.digest.inject_on_session_start').textContent).toMatch(/Saved · by mem_1/);
    expect(screen.getByTestId('saved-cortex.digest.tier').textContent).toBe('Server default');
  });

  it('saves a toggle on change and a text leaf on blur, each to its own leaf', async () => {
    const { sent } = server(base({ '/api/settings/cortex.digest.inject_on_session_start': () => Response.json({ applied: true }), '/api/settings/agent.provider.model': () => Response.json({ applied: true }) }));
    mount('/settings');
    await tab('Cortex');
    fireEvent.click(await screen.findByRole('switch', { name: 'Digest at session start' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/settings/cortex.digest.inject_on_session_start', body: { value: false } });
    expect(sent[0]!.headers[STEP_UP_HEADER]).toBeUndefined();
    await tab('Agent');
    const model = await screen.findByLabelText('Model');
    fireEvent.change(model, { target: { value: 'claude-opus' } });
    fireEvent.blur(model);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'PUT', path: '/api/settings/agent.provider.model', body: { value: 'claude-opus' } });
  });

  it('asks for a step-up key on a step-up leaf and sends it in the header', async () => {
    const { sent } = server(base({ '/api/settings/agent.provider.base_url': () => Response.json({ applied: true }) }));
    mount('/settings');
    await tab('Agent');
    const url = await screen.findByLabelText('Provider endpoint');
    fireEvent.change(url, { target: { value: 'https://llm.example' } });
    fireEvent.blur(url);
    expect(await screen.findByText(/This change needs a step-up key/)).toBeTruthy();
    expect(sent).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Step-up key'), { target: { value: 'k'.repeat(43) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/settings/agent.provider.base_url', body: { value: 'https://llm.example' } });
    expect(sent[0]!.headers[STEP_UP_HEADER]).toBe('k'.repeat(43));
  });

  it('says the refusal in the person\'s words: an unauthorized change asks for a key, a foreign leaf is named as not held', async () => {
    server(base({
      '/api/settings/cortex.digest.tier': () => Response.json({ applied: false, reason: 'not_deployment_tier', leaf: 'cortex.digest.tier' }, { status: 400 }),
      '/api/settings/embedding.model': () => Response.json({ applied: false, reason: 'unauthorized', leaf: 'embedding.model' }, { status: 403 }),
    }));
    mount('/settings');
    await tab('Cortex');
    fireEvent.change(await screen.findByLabelText('Digest size'), { target: { value: '5000' } });
    expect((await screen.findByTestId('saved-cortex.digest.tier')).textContent).toBe('That setting is not held by the server.');
    await tab('Embedding');
    const model = await screen.findByLabelText('Model');
    fireEvent.change(model, { target: { value: 'nomic' } });
    fireEvent.blur(model);
    expect(await screen.findByText(/This change needs a step-up key/)).toBeTruthy();
  });

  it('stores a credential once with the key and never shows it afterwards', async () => {
    const { sent } = server(base({ '/api/secrets/anthropic': () => Response.json({ name: 'anthropic', configured: true, readable: true, maskedValue: 's…0', updatedAt: NOW, updatedBy: 'mem_1' }) }));
    mount('/settings');
    await tab('Credentials');
    expect(await screen.findByText('s…c')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Rotate' })[0]!);
    fireEvent.change(await screen.findByLabelText('Credential value'), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Step-up key'), { target: { value: 'k'.repeat(43) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/secrets/anthropic', body: { value: SECRET } });
    expect(sent[0]!.headers[STEP_UP_HEADER]).toBe('k'.repeat(43));
    await waitFor(() => expect(screen.queryByLabelText('Step-up key')).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const el of document.querySelectorAll('input, textarea')) expect((el as HTMLInputElement).value).not.toBe(SECRET);
  });

  it('toggles a project capability through the project route', async () => {
    const { sent } = server(base({ '/api/projects/x/capabilities/cortex': () => Response.json({ applied: true }) }));
    mount('/settings');
    await tab('Project capabilities');
    fireEvent.click(await screen.findByRole('switch', { name: 'Cortex: digests and instructions for Project X' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/projects/x/capabilities/cortex', body: { enabled: false } });
  });
});

describe('Operations and Notifications', () => {
  it('name what is pending rather than showing nothing, and the nav carries the three entries', async () => {
    server(base());
    mount('/operations');
    expect(await screen.findByTestId('pending-backup')).toBeTruthy();
    expect(screen.getByTestId('pending-diagnostics')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Server' });
    expect(within(nav).getByRole('link', { name: /Settings/ })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: /Operations/ })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: /Notifications/ })).toBeTruthy();
    cleanup();
    server(base());
    mount('/notifications');
    expect(await screen.findByTestId('pending-notifications')).toBeTruthy();
  });
});
