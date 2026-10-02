/**
 * Settings: what the server holds for every member, in five sections, each
 * change written to its own leaf, the provider keys never shown after they are
 * stored, titling imported sessions as a switch, and Sign-in and access as the
 * way to the pages that hold people, machines and access keys.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { LEAF_FIELDS, LEAF_GROUPS, groupsOf } from '../../packages/myco-server/ui/src/features/admin/settings/catalogue';
import { agentListRefusal, LeafControl, savedWords, WORKER_AGENTS } from '../../packages/myco-server/ui/src/features/admin/settings/LeafControl';
import { isRetired } from '../../packages/myco-server/ui/src/features/admin/settings/retired';
import { DEPLOYMENT_LEAVES, RETIRED_LEAVES, RETIRED_SECRET_SLOTS } from '../../packages/myco-server/src/core/settings';
import { oldTabTarget } from '../../packages/myco-server/ui/src/features/admin/settings/SettingsPage';
import { liftsAt, policyWords, progressWords, waitingWords } from '../../packages/myco-server/ui/src/features/admin/settings/titling';
import { SETTINGS_SECTIONS } from '../../packages/myco-server/ui/src/routes/nav';
import { OUTCOME_TASKS, TASK_TIERS } from '../../packages/myco-server/src/core/task-catalogue';
import { rawIdsIn } from '../helpers/raw-ids';

const ADA = 'mem_q3Vb8xRk2LmT7wYz';
const LIN = 'mem_Hn5-pC0dJfA9sE_u';
const ME = { sub: '583231', login: 'ada', member: { id: ADA, label: 'Ada', role: 'admin' as const } };
const P_X = 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11';
const P_ARCHIVED = 'proj_a71a5c0e2b9d4f8e6c3a1b7d5e9f0c22';
const PROJECTS = { projects: [
  { projectId: P_X, name: 'Project X', createdAt: 0, sessionCount: 0, lastActivityAt: null, archivedAt: null, archivedBy: null },
  { projectId: P_ARCHIVED, name: 'Old thing', createdAt: 0, sessionCount: 0, lastActivityAt: null, archivedAt: 1, archivedBy: ADA },
] };
const MEMBERS = { members: [
  { id: ADA, label: 'Ada', role: 'admin', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
  // Joined without naming themselves: their label is their id.
  { id: LIN, label: LIN, role: 'member', linked: false, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
  { id: 'mem_harness', label: 'harness', role: 'admin', linked: false, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 0 },
] };
const NOW = Date.now();
const SECRET = 'sk-full-secret-value-1234567890';

/** One leaf as the server answers it, marked retired as the server marks it (`RETIRED_LEAVES`). */
const rowFor = (leaf: string) => ({ leaf, configured: false, value: null as unknown, updatedAt: null as number | null, updatedBy: null as string | null, retired: RETIRED_LEAVES.has(leaf) });
/** The settings the page offers, and those it keeps under Older settings, as the server's flags decide. */
const LIVE_FIELDS = LEAF_FIELDS.filter((f) => !isRetired(f, rowFor(f.leaf)));
const RETIRED_FIELDS = [...RETIRED_LEAVES].map((leaf) => ({ leaf }));
const leaves = (over: Record<string, Partial<{ value: unknown; updatedBy: string; updatedAt: number; retired: boolean; editableValue: unknown; retiredValue: Record<string, unknown> }>> = {}) => ({
  taskTiers: OUTCOME_TASKS.map((task) => ({ task, tier: TASK_TIERS[task], source: 'task' })),
  leaves: DEPLOYMENT_LEAVES.map((leaf) => {
    const f = { leaf };
    const o = over[f.leaf];
    return { ...rowFor(f.leaf), editableValue: o?.editableValue, retiredValue: o?.retiredValue, configured: o?.value !== undefined, value: o?.value ?? null, updatedAt: o?.updatedAt ?? null, updatedBy: o?.updatedBy ?? null, retired: o?.retired ?? RETIRED_LEAVES.has(f.leaf) };
  }),
});
const secrets = (anthropicConfigured: boolean) => ({ secrets: [
  { name: 'anthropic', retired: RETIRED_SECRET_SLOTS.has('anthropic'), configured: anthropicConfigured, readable: true, maskedValue: anthropicConfigured ? 's…c' : null, updatedAt: anthropicConfigured ? NOW : null, updatedBy: anthropicConfigured ? ADA : null },
  { name: 'codex', retired: RETIRED_SECRET_SLOTS.has('codex'), configured: false, readable: true, maskedValue: null, updatedAt: null, updatedBy: null },
  { name: 'openai', retired: RETIRED_SECRET_SLOTS.has('openai'), configured: false, readable: true, maskedValue: null, updatedAt: null, updatedBy: null },
  { name: 'openrouter', retired: RETIRED_SECRET_SLOTS.has('openrouter'), configured: false, readable: true, maskedValue: null, updatedAt: null, updatedBy: null },
  { name: 'github', retired: RETIRED_SECRET_SLOTS.has('github'), configured: false, readable: true, maskedValue: null, updatedAt: null, updatedBy: null },
] });
const TITLING = { scheduledTasksEnabled: true, backfillEnabled: true, runsPerDay: 24, intervalSeconds: 900, runIn: ['active', 'idle'], overlap: 'queue', enabled: true, remaining: 12, owed: 0, usedToday: 3, inFlight: 1, completedToday: 2, failedToday: 0, waiting: null };

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
  '/api/members': () => Response.json(MEMBERS),
  '/api/settings': () => Response.json(leaves({ 'cortex.digest.inject_on_session_start': { value: true, updatedBy: ADA, updatedAt: NOW - 2 * 3_600_000 } })),
  '/api/secrets': () => Response.json(secrets(true)),
  '/api/titling-backfill': () => Response.json(TITLING),
  ...extra,
});

/** Opens a design-system select by its label and picks one option, the way a person does. */
async function pick(label: string, option: string) {
  const proto = window.HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
  proto.scrollIntoView ??= () => undefined;
  fireEvent.click(await screen.findByLabelText(label));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

function Where() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</span>;
}

function mount(path: string) {
  const proto = window.HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
  proto.scrollIntoView ??= () => undefined;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /><Where /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

const location = () => screen.getByTestId('location').textContent;
const sectionsNav = () => screen.findByRole('navigation', { name: 'Settings sections' });
/** Opens a section from the tab strip. */
async function section(label: string) {
  fireEvent.click(within(await sectionsNav()).getByRole('link', { name: label }));
  await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('link', { name: label }).getAttribute('aria-current')).toBe('page'));
}
const group = (label: string) => screen.findByRole('group', { name: label });
const statusOf = (leaf: string) => document.querySelector(`[data-setting-status="${leaf}"]`)?.textContent;
const SECTION_LABEL = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s.id, s.label])) as Record<string, string>;

describe('Settings, in five sections', () => {
  it('names tasks in user words and offers a repair for a stored invalid tier', async () => {
    const { sent } = server(base({
      '/api/settings': () => Response.json({
        ...leaves(),
        taskTiers: OUTCOME_TASKS.map((task) => task === 'title-summary'
          ? { task, tier: null, source: 'invalid', error: 'invalid_task_tier', repair: 'reset-task', remedy: 'Correct the tier in Settings or reset the task tier.' }
          : { task, tier: TASK_TIERS[task], source: 'task' }),
      }),
      '/api/settings/agent.tasks': () => Response.json({ applied: true }),
    }));
    mount('/settings/models');
    const editor = within(await group('Task tiers'));
    expect(editor.getByText('Learning')).toBeTruthy();
    expect(editor.getByText('Seeding')).toBeTruthy();
    expect(editor.getByText('Titling')).toBeTruthy();
    expect(editor.getByText('A code map update')).toBeTruthy();
    expect(editor.getByRole('combobox', { name: 'Titling tier' })).toBeTruthy();
    expect(statusOf('task-tier-title-summary')).toContain('Correct the tier in Settings or reset the task tier.');
    fireEvent.click(editor.getByRole('button', { name: 'Reset Titling tier' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PATCH', path: '/api/settings/agent.tasks', body: { task: 'title-summary', tier: null } });
    expect(groupsOf('models')[0]?.id).toBe('claude-profile');
    expect(LEAF_GROUPS.findIndex((group) => group.id === 'claude-profile')).toBeLessThan(LEAF_GROUPS.findIndex((group) => group.id === 'codex-profile'));
  });

  it('offers a whole-document reset when task overrides are malformed', async () => {
    const { sent } = server(base({
      '/api/settings': () => Response.json({
        ...leaves({ 'agent.tasks': { value: [] } }),
        taskTiers: OUTCOME_TASKS.map((task) => ({ task, tier: null, source: 'invalid', error: 'invalid_task_tier', repair: 'reset-leaf', remedy: 'Reset task overrides to restore defaults.' })),
      }),
      '/api/settings/agent.tasks': () => Response.json({ applied: true }),
    }));
    mount('/settings/models');
    const editor = within(await group('Task tiers'));
    expect(editor.queryByRole('button', { name: 'Reset Titling tier' })).toBeNull();
    fireEvent.click(editor.getByRole('button', { name: 'Reset task overrides' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'DELETE', path: '/api/settings/agent.tasks' });
  });

  it('shows an invalid stored profile value and its reset remedy', async () => {
    const leaf = 'agent.effort_map.codex.high';
    const { sent } = server(base({
      '/api/settings': () => Response.json({
        ...leaves({ [leaf]: { value: 'impossible' } }),
        leaves: leaves({ [leaf]: { value: 'impossible' } }).leaves.map((row) => row.leaf === leaf
          ? { ...row, source: 'invalid', error: 'invalid_value', remedy: 'Stored value is invalid. Correct it or reset this setting.' } : row),
      }),
      [`/api/settings/${leaf}`]: () => Response.json({ applied: true }),
    }));
    mount('/settings/models');
    await group('Codex tiers');
    expect(statusOf(leaf)).toContain('Correct it or reset this setting.');
    fireEvent.click(screen.getByRole('button', { name: 'Reset high tier effort' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'DELETE', path: `/api/settings/${leaf}` });
  });

  it('shows login choices in user words while saving their wire values', async () => {
    const leaf = 'agent.harnesses.claude-code.credential';
    const { sent } = server(base({
      '/api/settings': () => Response.json({ ...leaves(), leaves: leaves().leaves.map((row) => row.leaf === leaf
        ? { ...row, effectiveValue: 'deployment', source: 'default' } : row) }),
      [`/api/settings/${leaf}`]: () => Response.json({ applied: true }),
    }));
    mount('/settings/models');
    const claude = within(await group('Claude Code tiers'));
    expect(claude.getByLabelText('Sign in with')).toBeTruthy();
    expect(statusOf(leaf)).toBe('Server default: Server login');
    fireEvent.click(claude.getByLabelText('Sign in with'));
    fireEvent.click(await screen.findByRole('option', { name: 'Worker login' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: `/api/settings/${leaf}`, body: { value: 'worker-login' } });
  });

  it('patches and resets one task tier while keeping newer sibling fields', async () => {
    const initial = {
      'title-summary': { reasoningLevel: 'low', schedule: { maxRunsPerDay: 4 }, harness: 'claude-code', model: 'haiku' },
      'canopy-map': { schedule: { intervalSeconds: 600 } },
    };
    let document: Record<string, unknown> = initial;
    const { sent } = server(base({
      '/api/settings': () => Response.json({
        ...leaves({ 'agent.tasks': { value: document } }),
        taskTiers: OUTCOME_TASKS.map((task) => {
          const override = document[task] as { reasoningLevel?: 'low' | 'default' | 'high' } | undefined;
          return { task, tier: override?.reasoningLevel ?? TASK_TIERS[task], source: override?.reasoningLevel ? 'task-override' : 'task' };
        }),
      }),
      '/api/settings/agent.tasks': (init) => {
        const { task, tier } = JSON.parse(String(init?.body)) as { task: string; tier: string | null };
        const entry = { ...(document[task] as Record<string, unknown> ?? {}) };
        if (tier === null) delete entry.reasoningLevel;
        else entry.reasoningLevel = tier;
        document = { ...document, [task]: entry };
        return Response.json({ applied: true });
      },
    }));
    mount('/settings/models');
    const editor = within(await group('Task tiers'));
    expect(editor.getByText('Task override')).toBeTruthy();
    document = {
      'title-summary': { reasoningLevel: 'low', schedule: { maxRunsPerDay: 7 }, harness: 'claude-code', model: 'sonnet' },
      'canopy-map': { schedule: { intervalSeconds: 900 }, harness: 'codex' },
    };
    await pick('Titling tier', 'High');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PATCH', path: '/api/settings/agent.tasks', body: { task: 'title-summary', tier: 'high' } });
    expect(document).toEqual({
      'title-summary': { reasoningLevel: 'high', schedule: { maxRunsPerDay: 7 }, harness: 'claude-code', model: 'sonnet' },
      'canopy-map': { schedule: { intervalSeconds: 900 }, harness: 'codex' },
    });
    fireEvent.click(editor.getByRole('button', { name: 'Reset Titling tier' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'PATCH', path: '/api/settings/agent.tasks', body: { task: 'title-summary', tier: null } });
    expect(document).toEqual({
      'title-summary': { schedule: { maxRunsPerDay: 7 }, harness: 'claude-code', model: 'sonnet' },
      'canopy-map': { schedule: { intervalSeconds: 900 }, harness: 'codex' },
    });
    await waitFor(() => expect(statusOf('task-tier-title-summary')).toBe('Task default'));
  });

  it('edits a tier model and resets that leaf alone', async () => {
    const model = 'agent.reasoning_map.claude-code.low';
    const { sent } = server(base({
      '/api/settings': () => Response.json(leaves({ [model]: { value: 'sonnet', updatedBy: ADA, updatedAt: NOW } })),
      [`/api/settings/${model}`]: () => Response.json({ applied: true }),
    }));
    mount('/settings/models');
    const tiers = within(await group('Claude Code tiers'));
    const input = tiers.getByLabelText('low tier model');
    expect((input as HTMLInputElement).value).toBe('sonnet');
    fireEvent.change(input, { target: { value: 'haiku' } });
    fireEvent.blur(input);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: `/api/settings/${model}`, body: { value: 'haiku' } });
    fireEvent.click(tiers.getByRole('button', { name: 'Reset low tier model' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'DELETE', path: `/api/settings/${model}` });
  });

  it('lists the five sections as one strip of tabs, each at its own address, the first current on /settings', async () => {
    server(base());
    mount('/settings');
    const nav = await sectionsNav();
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Myco’s work', 'Models and keys', 'Capture and retention', 'Backups', 'Sign-in and access']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/settings', '/settings/models', '/settings/capture', '/settings/backups', '/settings/access']);
    expect(links[0]!.getAttribute('aria-current')).toBe('page');
    // The strip never wraps: it scrolls in its own box.
    expect(nav.className).toContain('overflow-x-auto');
    await section('Backups');
    expect(location()).toBe('/settings/backups');
    expect(await group('Backups')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'When Myco works' })).toBeNull();
  });

  it('renders a control for every catalogued leaf across the sections, and names who saved a configured one, never by id', async () => {
    server(base());
    mount('/settings');
    let controls = 0;
    for (const s of SETTINGS_SECTIONS) {
      const groups = groupsOf(s.id);
      if (groups.length === 0) continue;
      await section(s.label);
      for (const g of groups) {
        const live = g.leaves.filter((f) => LIVE_FIELDS.includes(f));
        if (live.length === 0) continue;
        const card = await group(g.label);
        for (const f of live) {
          expect({ leaf: f.leaf, present: within(card).queryByLabelText(f.label) !== null }).toEqual({ leaf: f.leaf, present: true });
          controls += 1;
        }
      }
    }
    expect(controls).toBe(LIVE_FIELDS.length);
    await section('Myco’s work');
    await group('What sessions receive');
    // Nothing stored: the field shows the server's default in words, so the status says only that it is the default.
    expect(statusOf('cortex.spores.inject_on_prompt_submit')).toBe('Server default: on');
    expect(statusOf('agent.scheduled_tasks_active_window_days')).toBe('Server default');
    expect(statusOf('agent.limits.concurrent_runs')).toBe('Server default');
    expect((screen.getByLabelText('Tasks at once') as HTMLInputElement).placeholder).toBe('No limit');
    // A retired setting with a value stored sits under Older settings, and says nothing reads it.
    fireEvent.click(within(await screen.findByRole('region', { name: 'Older settings' })).getByRole('button', { name: /^Older settings/ }));
    expect(document.querySelector('[data-retired-setting="cortex.digest.inject_on_session_start"]')).toBeTruthy();
    expect(rawIdsIn(document.body, ['[data-testid="location"]'])).toEqual([]);
  });

  it('places every group in exactly one section, and leaves Sign-in and access to pointers', () => {
    expect(new Set(LEAF_GROUPS.map((g) => g.id)).size).toBe(LEAF_GROUPS.length);
    for (const g of LEAF_GROUPS) expect(SECTION_LABEL[g.section]).toBeDefined();
    expect(groupsOf('access')).toEqual([]);
    for (const id of ['work', 'models', 'capture', 'backups'] as const) expect(groupsOf(id).length).toBeGreaterThan(0);
  });

  it('saves a toggle on change and a text leaf on blur, each to its own leaf', async () => {
    const { sent } = server(base({ '/api/settings/cortex.spores.inject_on_prompt_submit': () => Response.json({ applied: true }), '/api/settings/embedding.model': () => Response.json({ applied: true }) }));
    mount('/settings');
    // The server serves spores unless told not to, so with nothing stored the switch reads on, and a flip turns it off.
    const spores = await screen.findByRole('switch', { name: 'Spores on every prompt' });
    expect(spores.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(spores);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/settings/cortex.spores.inject_on_prompt_submit', body: { value: false } });
    await section('Models and keys');
    const model = await screen.findByLabelText('Embedding model');
    fireEvent.change(model, { target: { value: 'claude-opus' } });
    fireEvent.blur(model);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'PUT', path: '/api/settings/embedding.model', body: { value: 'claude-opus' } });
  });

  it('applies an endpoint change directly on the member session, with no dialog and no extra header', async () => {
    const { sent } = server(base({ '/api/settings/embedding.base_url': () => Response.json({ applied: true }) }));
    mount('/settings/models');
    const url = await screen.findByLabelText('Embedding endpoint');
    fireEvent.change(url, { target: { value: 'https://llm.example' } });
    fireEvent.blur(url);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/settings/embedding.base_url', body: { value: 'https://llm.example' } });
    expect(Object.keys(sent[0]!.headers).some((h) => h.startsWith('x-myco-'))).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says the refusal in the person\'s words: a foreign leaf is named as not held, any other refusal carries its status, and a bad number never leaves', async () => {
    const { sent } = server(base({
      '/api/settings/cortex.spores.inject_on_prompt_submit': () => Response.json({ applied: false, reason: 'not_deployment_tier', leaf: 'cortex.spores.inject_on_prompt_submit' }, { status: 400 }),
      '/api/settings/embedding.model': () => Response.json({ error: 'nope' }, { status: 503 }),
    }));
    mount('/settings');
    fireEvent.click(await screen.findByRole('switch', { name: 'Spores on every prompt' }));
    await waitFor(() => expect(statusOf('cortex.spores.inject_on_prompt_submit')).toBe('That setting is not held by the server.'));
    const limit = await screen.findByLabelText('Items per prompt');
    fireEvent.change(limit, { target: { value: '11' } });
    fireEvent.blur(limit);
    await waitFor(() => expect(statusOf('cortex.spores.max_per_prompt')).toBe('Enter a number from 0 to 10.'));
    await section('Models and keys');
    const model = await screen.findByLabelText('Embedding model');
    fireEvent.change(model, { target: { value: 'nomic' } });
    fireEvent.blur(model);
    await waitFor(() => expect(statusOf('embedding.model')).toBe('The server refused (503).'));
    expect(sent.map((s) => s.path)).toEqual(['/api/settings/cortex.spores.inject_on_prompt_submit', '/api/settings/embedding.model']);
  });


  it('saves the task overrides document on Save, and refuses one that is not JSON before it leaves', async () => {
    const { sent } = server(base({ '/api/settings/agent.tasks': () => Response.json({ applied: true }) }));
    mount('/settings/models');
    const doc = await screen.findByLabelText('Task overrides');
    const row = doc.closest('[data-setting]') as HTMLElement;
    fireEvent.change(doc, { target: { value: '{"title-summary":' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(statusOf('agent.tasks')).toBe('Enter valid JSON.'));
    fireEvent.change(doc, { target: { value: '{"title-summary": {"harness": "codex"}}' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/settings/agent.tasks', body: { value: { 'title-summary': { harness: 'codex' } } } });
  });

  it('picks the preferred agent from the agents a machine can run, and clears it to no preference', async () => {
    let held: unknown;
    const { sent } = server(base({
      '/api/settings': () => Response.json(leaves(held === undefined ? {} : { 'worker.harness': { value: held, updatedBy: ADA, updatedAt: NOW } })),
      '/api/settings/worker.harness': (init) => { held = JSON.parse(String(init!.body)).value; return Response.json({ applied: true }); },
    }));
    mount('/settings');
    await waitFor(() => expect(statusOf('worker.harness')).toBe('Server default'));
    await pick('Preferred agent', 'Codex');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/settings/worker.harness', body: { value: 'codex' } });
    await waitFor(() => expect(screen.getByLabelText('Preferred agent').textContent).toContain('Codex'));
    await pick('Preferred agent', 'No preference');
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ path: '/api/settings/worker.harness', body: { value: null } });
  });

  it('keeps the fallback agents in order, and saves a list only of agents a machine can run, each once', async () => {
    const held = { value: ['bogus', 'codex'] as unknown[] };
    const { sent } = server(base({
      '/api/settings': () => Response.json(leaves({ 'worker.harness_fallback': { value: held.value, updatedBy: ADA, updatedAt: NOW } })),
      '/api/settings/worker.harness_fallback': (init) => { held.value = JSON.parse(String(init!.body)).value; return Response.json({ applied: true }); },
    }));
    mount('/settings');
    const list = await screen.findByRole('list', { name: 'Then try, in order' });
    expect(within(list).getAllByRole('listitem').map((li) => li.getAttribute('data-agent'))).toEqual(['bogus', 'codex']);
    expect(list.textContent).toContain('bogus (not an agent a machine can run)');
    // A change that keeps the unknown entry is refused before it leaves.
    fireEvent.click(screen.getByRole('button', { name: 'Move Codex up' }));
    await waitFor(() => expect(statusOf('worker.harness_fallback')).toBe('Not an agent a machine can run: bogus.'));
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove bogus' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/settings/worker.harness_fallback', body: { value: ['codex'] } });
    await pick('Add to then try, in order', 'Claude Code');
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ body: { value: ['codex', 'claude-code'] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Move Claude Code up' }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toMatchObject({ body: { value: ['claude-code', 'codex'] } });
  });

  it('refuses a fallback list with an unknown agent or one listed twice, by the same agents the server opens a key for', () => {
    expect(WORKER_AGENTS).toEqual(['claude-code', 'codex', 'opencode', 'cursor', 'antigravity']);
    expect(agentListRefusal(['codex', 'cursor'])).toBeNull();
    expect(agentListRefusal(['codex', 'codex'])).toBe('Each agent can be listed once.');
    expect(agentListRefusal(['codex', 7])).toBe('Not an agent a machine can run: 7.');
  });

  it('adds and removes a path the code map leaves out, writing the whole list to its leaf', async () => {
    const { sent } = server(base({
      '/api/settings': () => Response.json(leaves({ 'cortex.canopy.exclude.patterns': { value: ['fixtures'], updatedBy: ADA, updatedAt: NOW } })),
      '/api/settings/cortex.canopy.exclude.patterns': () => Response.json({ applied: true }),
    }));
    mount('/settings');
    fireEvent.change(await screen.findByLabelText('Add to paths left out'), { target: { value: '**/*.generated.ts' } });
    fireEvent.click(within(screen.getByLabelText('Add to paths left out').closest('[data-setting]') as HTMLElement).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ body: { value: ['fixtures', '**/*.generated.ts'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove fixtures' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ body: { value: [] } });
  });

  /**
   * The 2.0 leaves, each written on its own and each leaving its siblings
   * alone. The silent-data-loss shape is a form that writes a whole settings
   * document: one field edited, every sibling overwritten with whatever the form
   * held. Each edit here produces exactly one request, naming exactly its own
   * leaf, carrying exactly its own value, and every other leaf still reads back
   * what the server holds afterwards.
   */
  it('writes each 2.0 leaf on its own and leaves every sibling reading what the server holds', async () => {
    const CONFIGURED: Record<string, unknown> = {
      'instructions.template': '# House rules',
      'worker.harness': 'claude-code',
      'retention.transcripts': 30,
      'import.window_days': 45,
      'import.max_sessions_per_harness': 25,
      'agent.limits.task_runs_per_hour': 6,
    };
    const held = { ...CONFIGURED };
    const { sent } = server(base({
      '/api/settings': () => Response.json({
        leaves: LEAF_FIELDS.map((f) => ({
          leaf: f.leaf, configured: f.leaf in held, value: held[f.leaf] ?? null,
          updatedAt: f.leaf in held ? NOW : null, updatedBy: f.leaf in held ? ADA : null,
        })),
      }),
      '/api/settings/retention.transcripts': (init) => {
        held['retention.transcripts'] = JSON.parse(String(init!.body)).value;
        return Response.json({ applied: true });
      },
    }));
    mount('/settings?tab=records');

    const window = await screen.findByLabelText('Keep raw transcripts for');
    expect((window as HTMLInputElement).value).toBe('30');
    fireEvent.change(window, { target: { value: '0' } });
    fireEvent.blur(window);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/settings/retention.transcripts', body: { value: 0 } });
    expect(Object.keys(sent[0]!.body as object)).toEqual(['value']);

    await waitFor(() => expect((screen.getByLabelText('Keep raw transcripts for') as HTMLInputElement).value).toBe('0'));
    for (const [sectionLabel, label, leaf] of [
      ['Myco’s work', 'Session-start instructions', 'instructions.template'],
      ['Capture and retention', 'Reach back at most', 'import.window_days'],
      ['Capture and retention', 'At most, per agent', 'import.max_sessions_per_harness'],
      ['Myco’s work', 'Runs of one task per hour', 'agent.limits.task_runs_per_hour'],
    ] as const) {
      await section(sectionLabel);
      const field = await screen.findByLabelText(label);
      expect({ leaf, value: (field as HTMLInputElement).value }).toEqual({ leaf, value: String(CONFIGURED[leaf]) });
    }
    await section('Myco’s work');
    expect((await screen.findByLabelText('Preferred agent')).textContent).toContain('Claude Code');
    expect(sent).toHaveLength(1);
  });

  /**
   * Every kind of control honours the read-only flag, not only the kinds the
   * catalogue happens to mark today: the catalogue carries no read-only
   * `select`, `text` or `textarea`, so one of each is rendered directly.
   */
  it.each(['toggle', 'number', 'text', 'textarea', 'select', 'json'] as const)('does not offer a read-only %s', async (kind) => {
    const field = { leaf: `probe.${kind}`, label: `Probe ${kind}`, kind, readOnly: true, options: ['a', 'b'] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    server(base());
    render(
      <AppearanceProvider><QueryClientProvider client={client}><MemoryRouter>
        <LeafControl field={field} row={{ leaf: field.leaf, configured: true, value: kind === 'toggle' ? true : 'a', updatedAt: NOW, updatedBy: ADA }} />
      </MemoryRouter></QueryClientProvider></AppearanceProvider>,
    );
    const control = await screen.findByLabelText(field.label);
    const offered = control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement
      ? !control.readOnly && !control.disabled
      : !(control as HTMLButtonElement).disabled;
    expect({ kind, offered }).toEqual({ kind, offered: false });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  /**
   * A setting nothing on the server reads any more is not offered. With no
   * value stored it is not shown at all; with one stored, it is listed under
   * "Older settings" at its section's foot, read-only, and never writes.
   */
  it('leaves out a retired setting with no value stored, and shows one with a value stored under Older settings, read-only', async () => {
    const retired = RETIRED_FIELDS.filter((field) => !LEAF_FIELDS.some((f) => f.leaf === field.leaf && f.readOnly));
    expect(retired.length).toBeGreaterThan(0);
    server(base({ '/api/settings': () => Response.json(leaves()) }));
    mount('/settings');
    await group('When Myco works');
    for (const s of SETTINGS_SECTIONS.filter((x) => x.id !== 'access')) {
      await section(s.label);
      await screen.findByRole('group', { name: groupsOf(s.id).find((g) => g.leaves.some((f) => LIVE_FIELDS.includes(f)))!.label });
      for (const f of retired) expect({ leaf: f.leaf, shown: document.querySelector(`[data-setting="${f.leaf}"]`) !== null }).toEqual({ leaf: f.leaf, shown: false });
      // A boolean, not the element: a failed match would print the element's whole object graph.
      expect({ section: s.id, older: document.querySelector('[data-older-settings]') !== null }).toEqual({ section: s.id, older: false });
    }
    cleanup();

    const { sent } = server(base({ '/api/settings': () => Response.json(leaves({
      'skills.usage_stale_days': { value: 45, updatedBy: ADA, updatedAt: NOW },
      'agent.event_tasks_enabled': { value: true, updatedBy: ADA, updatedAt: NOW },
    })) }));
    mount('/settings');
    const older = await screen.findByRole('region', { name: 'Older settings' });
    fireEvent.click(within(older).getByRole('button', { name: 'Older settings (2)' }));
    expect(within(older).getByText('skills.usage_stale_days')).toBeTruthy();
    expect(within(older).getByText('45')).toBeTruthy();
    expect(within(older).getByText('agent.event_tasks_enabled')).toBeTruthy();
    expect(within(older).queryByRole('switch')).toBeNull();
    expect(within(older).queryByRole('textbox')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('takes which settings and keys are retired from the server\'s answer, not from a list of its own', async () => {
    server(base({
      '/api/settings': () => Response.json(leaves({
        'cortex.digest.tier': { value: 8000, updatedBy: ADA, updatedAt: NOW, retired: true },
      })),
      '/api/secrets': () => {
        const answer = secrets(false);
        answer.secrets[1] = { ...answer.secrets[1]!, retired: true, configured: true, maskedValue: 'c…x', updatedAt: NOW, updatedBy: ADA };
        return Response.json(answer);
      },
    }));
    mount('/settings');
    const older = await screen.findByRole('region', { name: 'Older settings' });
    expect(within(await group('What sessions receive')).queryByLabelText('Digest size')).toBeNull();
    fireEvent.click(within(older).getByRole('button', { name: 'Older settings (1)' }));
    expect(within(older).getByText('cortex.digest.tier')).toBeTruthy();
    expect(within(older).queryByRole('combobox')).toBeNull();

    await section('Models and keys');
    const keys = await group('Keys');
    expect(within(keys).queryByText('Codex (OpenAI)')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Older keys' })).toBeTruthy();
  });

  it('shows every switch at the value the server applies while nothing is stored', async () => {
    server(base({ '/api/settings': () => Response.json(leaves()) }));
    mount('/settings');
    for (const [label, on] of [
      ['Instructions at session start', true], ['Instructions when a subagent starts', true], ['Plan nudge on every prompt', true],
      ['Spores on every prompt', true], ['Work on a schedule', false], ['Update the map on its own', false],
    ] as const) {
      const toggle = await screen.findByRole('switch', { name: label });
      expect({ label, on: toggle.getAttribute('aria-checked') === 'true' }).toEqual({ label, on });
    }
    expect(statusOf('cortex.instructions.inject_on_session_start')).toBe('Server default: on');
    expect(statusOf('agent.scheduled_tasks_enabled')).toBe('Server default: off');
  });

  it('says what the server said was wrong with a value it refused', async () => {
    server(base({ '/api/settings/cortex.spores.max_per_prompt': () => Response.json({ applied: false, reason: 'invalid_value', leaf: 'cortex.spores.max_per_prompt', detail: 'expected a whole number' }, { status: 400 }) }));
    mount('/settings');
    const limit = await screen.findByLabelText('Items per prompt');
    fireEvent.change(limit, { target: { value: '3' } });
    fireEvent.blur(limit);
    await waitFor(() => expect(statusOf('cortex.spores.max_per_prompt')).toBe('The server refused that value.'));
  });

  it('words where a value stands, naming a person only by a name', () => {
    const row = { leaf: 'x', configured: true, value: 1, updatedAt: NOW - 2 * 3_600_000, updatedBy: ADA };
    expect(savedWords(row, 'Ada', NOW)).toBe('Saved by Ada · 2 h ago');
    expect(savedWords(row, null, NOW)).toBe('Saved 2 h ago');
    expect(savedWords({ ...row, configured: false }, 'Ada', NOW)).toBe('Server default');
    expect(savedWords(undefined, null, NOW, '14 days')).toBe('Server default: 14 days');
  });
});

describe('older links to a Settings tab', () => {
  it('lead each tab to the section that holds its group now, at the group', () => {
    expect(oldTabTarget('secrets')).toBe('/settings/models#credentials');
    expect(oldTabTarget('capabilities')).toBe('/settings/access#projects');
    expect(oldTabTarget('records')).toBe('/settings/capture#records');
    expect(oldTabTarget('agent')).toBe('/settings/models');
    expect(oldTabTarget('skills')).toBe('/settings');
    expect(oldTabTarget('backup')).toBe('/settings/backups#backup');
    expect(oldTabTarget('maintenance')).toBe('/settings/backups#maintenance');
    expect(oldTabTarget('cortex')).toBe('/settings#cortex');
    expect(oldTabTarget('nope')).toBe('/settings');
    for (const old of ['scheduling', 'limits', 'cortex', 'code-map', 'embedding', 'workers', 'backup', 'maintenance', 'records', 'import', 'advanced']) {
      expect({ old, group: LEAF_GROUPS.some((g) => g.id === old) }).toEqual({ old, group: true });
    }
  });

  it('replace the address with the section and land on the group', async () => {
    server(base());
    mount('/settings?tab=secrets');
    await waitFor(() => expect(location()).toBe('/settings/models#credentials'));
    expect(await screen.findByRole('group', { name: 'Keys' })).toBeTruthy();
    cleanup();
    server(base());
    mount('/settings?tab=capabilities');
    await waitFor(() => expect(location()).toBe('/settings/access#projects'));
    expect(await screen.findByRole('group', { name: 'Projects' })).toBeTruthy();
  });
});

describe('provider keys', () => {
  it('stores a key from the session alone and never shows it afterwards, and removes one from its menu behind a confirm', async () => {
    const { sent } = server(base({ '/api/secrets/anthropic': (init) => (init?.method === 'DELETE' ? Response.json({ deleted: true }) : Response.json({ name: 'anthropic', retired: RETIRED_SECRET_SLOTS.has('anthropic'), configured: true, readable: true, maskedValue: 's…0', updatedAt: NOW, updatedBy: ADA })) }));
    mount('/settings/models');
    const keys = await group('Keys');
    await waitFor(() => expect(within(keys).getByText(/s…c/)).toBeTruthy());
    expect(statusOf('secret.anthropic')).toContain('saved by Ada');
    fireEvent.click(within(keys).getByRole('button', { name: 'Replace' }));
    fireEvent.change(await screen.findByLabelText('Key'), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/secrets/anthropic', body: { value: SECRET } });
    await waitFor(() => expect(screen.queryByLabelText('Key')).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const el of document.querySelectorAll('input, textarea')) expect((el as HTMLInputElement).value).not.toBe(SECRET);
    // Removing is in the key's menu, and asks first.
    expect(within(keys).queryByRole('button', { name: 'Remove key' })).toBeNull();
    fireEvent.keyDown(within(keys).getByRole('button', { name: 'More for the Anthropic key' }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Remove key' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('stops working until a new one is stored');
    expect(sent).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'DELETE', path: '/api/secrets/anthropic' });
  });

  it('keeps the dialog open with the refusal when a key is refused', async () => {
    server(base({ '/api/secrets/codex': () => Response.json({ error: 'bad_request', reason: 'a key carries no line breaks' }, { status: 400 }) }));
    mount('/settings/models');
    const keys = await group('Keys');
    fireEvent.click(within(within(keys).getByText('Codex (OpenAI)').closest('[data-setting]') as HTMLElement).getByRole('button', { name: 'Set' }));
    fireEvent.change(await screen.findByLabelText('Key'), { target: { value: 'x\ny' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The server could not accept that.');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('names what each key is used for, so a key stored for embeddings is not mistaken for a run\'s login (#1212)', async () => {
    server(base());
    mount('/settings/models');
    const keys = await group('Keys');
    const row = (label: string) => within(keys).getByText(label).closest('[data-setting]')!.textContent ?? '';
    expect(row('Codex (OpenAI)')).toContain('Codex uses this key for Myco’s work in place of the machine’s own sign-in');
    expect(row('OpenAI')).toContain('Used for embeddings, when the embedding provider is OpenAI.');
    expect(row('OpenAI')).not.toContain('Codex');
    expect(row('Anthropic')).toContain('Claude Code, OpenCode and Cursor use this key');
    // Nothing reads the GitHub key: with none stored it is not offered.
    expect(within(keys).queryByText('GitHub')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Older keys' })).toBeNull();
  });

  it('lists a stored GitHub key, which nothing reads, under Older keys with no control', async () => {
    const stored = secrets(true);
    stored.secrets[4] = { ...stored.secrets[4]!, configured: true, maskedValue: 'g…h', updatedAt: NOW, updatedBy: ADA };
    server(base({ '/api/secrets': () => Response.json(stored) }));
    mount('/settings/models');
    fireEvent.click(await screen.findByRole('button', { name: 'Older keys' }));
    const older = await screen.findByRole('group', { name: 'Older keys' });
    expect(older.textContent).toContain('Nothing on this server reads this key any more.');
    expect(within(older).queryAllByRole('button')).toEqual([]);
  });
});

describe('Title imported sessions', () => {
  it('reads the switch from the titling route, says where titling stands, and writes the switch back', async () => {
    let progress = { ...TITLING, backfillEnabled: false, enabled: false };
    const { sent } = server(base({
      '/api/titling-backfill': (init) => {
        if (init?.method === 'PUT') {
          const enabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
          progress = { ...progress, backfillEnabled: enabled, enabled, usedToday: 5, inFlight: 5, waiting: { reason: 'ceiling', until: Date.now() + 2 * 3_600_000 } as never };
        }
        return Response.json(progress);
      },
    }));
    mount('/settings');
    const toggle = await screen.findByRole('switch', { name: 'Title imported sessions' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    const words = () => document.querySelector('[data-titling-progress]')!.textContent ?? '';
    expect(words()).toContain('12 imported sessions are waiting for a title. Titling imported sessions is off.');
    fireEvent.click(toggle);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/titling-backfill', body: { enabled: true } });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Title imported sessions' }).getAttribute('aria-checked')).toBe('true'));
    expect(words()).toContain('Today’s limit of 24 is reached; the next title can start at ');
    expect(words()).toContain('Titles start while the server is in use or idle, at most once every 15 min. Today: 5 of 24 started, 5 in progress, 2 titled, 0 failed.');
    // And back off: the value sent is the switch's new state, each way.
    fireEvent.click(screen.getByRole('switch', { name: 'Title imported sessions' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'PUT', path: '/api/titling-backfill', body: { enabled: false } });
  });

  it('shows it on where the server has it on', async () => {
    server(base());
    mount('/settings');
    const toggle = await screen.findByRole('switch', { name: 'Title imported sessions' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });

  it('says when titling cannot be read and reads it again on request, and says when the switch was refused and tries again', async () => {
    let reads = 0;
    let puts = 0;
    const progress = { ...TITLING, backfillEnabled: false, enabled: false, remaining: 3 };
    server(base({
      '/api/titling-backfill': (init) => {
        if (init?.method === 'PUT') { puts++; return puts === 1 ? new Response(null, { status: 503 }) : Response.json({ ...progress, backfillEnabled: true, enabled: true }); }
        reads++;
        return reads === 1 ? new Response(null, { status: 503 }) : Response.json(progress);
      },
    }));
    mount('/settings');
    expect(await screen.findByText('Couldn’t read where titling stands just now.')).toBeTruthy();
    fireEvent.click(within(document.querySelector('[data-setting="titling-backfill"]') as HTMLElement).getByRole('button', { name: 'Retry' }));
    const toggle = await screen.findByRole('switch', { name: 'Title imported sessions' });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    fireEvent.click(toggle);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('didn’t turn titling imported sessions on');
    expect(screen.getByRole('switch', { name: 'Title imported sessions' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Title imported sessions' }).getAttribute('aria-checked')).toBe('true'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(puts).toBe(2);
  });

  it('words titling in every state, and its schedule', () => {
    const base = { scheduledTasksEnabled: true, backfillEnabled: true, runsPerDay: 24, intervalSeconds: 900, runIn: ['active', 'idle'], overlap: 'queue' as const, enabled: true, remaining: 0, owed: 0, usedToday: 3, inFlight: 1, completedToday: 2, failedToday: 0, waiting: null };
    expect(progressWords(base)).toBe('No session that ended here is waiting for a title. No imported session is waiting for a title. Titles start while the server is in use or idle, at most once every 15 min. Today: 3 of 24 started, 1 in progress, 2 titled, 0 failed.');
    expect(progressWords({ ...base, owed: 4, remaining: 1, runsPerDay: null, runIn: ['idle'], intervalSeconds: 60 })).toBe('4 sessions that ended here are waiting for a title; they are titled on their own within the daily limit. 1 imported session is waiting for a title. Titles start while the server is idle, at most once every 1 min. Today: 3 started, 1 in progress, 2 titled, 0 failed.');
    expect(progressWords({ ...base, scheduledTasksEnabled: false, enabled: false, owed: 1 })).toBe('1 session that ended here is waiting for a title; they are titled on their own within the daily limit. No imported session is waiting for a title. Titling them is on, but runs only while Work on a schedule is on. Titles start while the server is in use or idle, at most once every 15 min. Today: 3 of 24 started, 1 in progress, 2 titled, 0 failed.');
    expect(progressWords({ ...base, backfillEnabled: false, enabled: false, remaining: 2 })).toContain('2 imported sessions are waiting for a title. Titling imported sessions is off.');
    expect(policyWords({ runIn: ['active', 'idle', 'sleep'], intervalSeconds: 3600 })).toBe('Titles start while the server is in use, idle or asleep, at most once every 60 min.');
    expect(policyWords({ runIn: [], intervalSeconds: 10 })).toBe('Titles start in no state of the server, at most once every 1 min.');
  });

  it('says what holds the next title while sessions wait for one, and when it can start', () => {
    const now = 1_800_000_000_000;
    const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const later = now + 150 * 60_000;
    expect(liftsAt(later, now)).toBe(`at ${clock(later)} (in 3h)`);
    expect(liftsAt(null, now)).toBe('soon');
    expect(liftsAt(now, now)).toBe('soon');
    expect(liftsAt(now - 60_000, now)).toBe('soon');
    expect(waitingWords({ runsPerDay: 24, waiting: null }, now)).toBe('');
    expect(waitingWords({ runsPerDay: 24, waiting: { reason: 'ceiling', until: later } }, now)).toBe(`Today’s limit of 24 is reached; the next title can start at ${clock(later)} (in 3h).`);
    expect(waitingWords({ runsPerDay: 0, waiting: { reason: 'ceiling', until: null } }, now)).toBe('The daily limit is 0, so nothing is titled until it is raised under Task overrides.');
    expect(waitingWords({ runsPerDay: 24, waiting: { reason: 'overlap', until: null } }, now)).toBe('Waiting for the title in progress to finish.');
    expect(waitingWords({ runsPerDay: 24, waiting: { reason: 'interval', until: now + 12 * 60_000 } }, now)).toBe(`The next titles can start at ${clock(now + 12 * 60_000)} (in 12m).`);
    expect(waitingWords({ runsPerDay: 24, waiting: { reason: 'interval', until: now - 1 } }, now)).toBe('The next titles can start soon.');
  });
});

describe('Sign-in and access', () => {
  it('counts the people who can sign in, never Myco, and leads to People & machines, My machines and each live project\'s access keys', async () => {
    server(base());
    mount('/settings/access');
    await waitFor(() => expect(document.querySelector('[data-pointer="people"]')?.textContent ?? '').toContain('2 people'));
    const people = document.querySelector('[data-pointer="people"]') as HTMLElement;
    expect(people.textContent).toContain('1 with a GitHub account connected; 1 without one yet');
    expect(within(people).getByRole('link').getAttribute('href')).toBe('/people');
    expect(within(document.querySelector('[data-pointer="my-machines"]') as HTMLElement).getByRole('link').getAttribute('href')).toBe('/me/machines');
    const projects = await screen.findByRole('group', { name: 'Projects' });
    expect(within(projects).getByText('Project X')).toBeTruthy();
    expect(within(projects).queryByText('Old thing')).toBeNull();
    expect(within(projects).getByRole('link').getAttribute('href')).toBe(`/p/${P_X}/settings#access-keys`);
    expect(rawIdsIn(document.body, ['[data-testid="location"]'])).toEqual([]);
  });
});


it('shows retired task preferences as metadata outside the task-overrides editor', async () => {
  const historic = { 'title-summary': { provider: 'anthropic', reasoningLevel: 'low' }, 'container-smoke': { model: 'haiku' } };
  server(base({ '/api/settings': () => Response.json(leaves({ 'agent.tasks': { value: historic,
    editableValue: { 'title-summary': { reasoningLevel: 'low' } },
    retiredValue: { 'title-summary': { provider: 'anthropic' }, 'container-smoke': { model: 'haiku' } } } })) }));
  mount('/settings/models');
  const editor = await screen.findByRole('textbox', { name: 'Task overrides' });
  expect((editor as HTMLTextAreaElement).value).not.toContain('provider');
  expect((editor as HTMLTextAreaElement).value).not.toContain('container-smoke');
  expect(screen.getByTestId('retired-task-overrides').textContent).toContain('container-smoke');
  expect(screen.getByTestId('retired-task-overrides').querySelectorAll('input,textarea,button')).toHaveLength(0);
});
it('describes weekly retention by the most recent weeks containing exports', () => {
  const field = LEAF_FIELDS.find(({ leaf }) => leaf === 'backup.retention.keep_weekly')!;
  expect(field.note).toContain('most recent weeks that contain exports');
});
