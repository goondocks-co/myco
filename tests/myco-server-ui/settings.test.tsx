/**
 * Settings: what the server holds for every member, in five sections, each
 * change written to its own leaf, the provider keys never shown after they are
 * stored, titling imported sessions as a switch, and Sign-in and access as the
 * way to the pages that hold people, machines and access keys.
 */
import { beforeAll, afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { LEAF_FIELDS, LEAF_GROUPS, groupsOf } from '../../packages/myco-server/ui/src/features/admin/settings/catalogue';
import { agentListRefusal, LeafControl, savedWords, WORKER_AGENTS } from '../../packages/myco-server/ui/src/features/admin/settings/LeafControl';
import { isRetired } from '../../packages/myco-server/ui/src/features/admin/settings/retired';
import { effectiveSettings } from '../../packages/myco-server/src/core/settings-policies';
import { sqliteEnv } from '../myco-server/helpers/fixtures';
import { DEPLOYMENT_LEAVES, RETIRED_LEAVES, RETIRED_SECRET_SLOTS } from '../../packages/myco-server/src/core/settings';
import { oldTabTarget } from '../../packages/myco-server/ui/src/features/admin/settings/SettingsPage';
import { liftsAt, policyWords, progressWords, waitingWords } from '../../packages/myco-server/ui/src/features/admin/settings/titling';
import { SETTINGS_SECTIONS } from '../../packages/myco-server/ui/src/routes/nav';
import { OUTCOME_TASKS, TASK_TIERS } from '../../packages/myco-server/src/core/task-catalogue';
import { rawIdsIn } from '../helpers/raw-ids';
import { settingsRefreshInterval } from '../../packages/myco-server/ui/src/hooks/use-settings';
import type { EmbeddingSwitchStatus } from '../../packages/myco-shared/src/settings-contract';

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

/** What a hosted server stores nothing for the embedding leaves resolves them to. */
const HOSTED_EMBEDDING: Readonly<Record<string, unknown>> = { 'embedding.provider': 'workers-ai', 'embedding.model': '@cf/baai/bge-m3' };
/** What the server applies to a leaf nobody wrote. */
const defaults = new Map<string, unknown>();
beforeAll(async () => {
  const { serverEnv, sqlite } = sqliteEnv();
  for (const [leaf, row] of await effectiveSettings(serverEnv)) defaults.set(leaf, row.effective);
  sqlite.close();
});
const effectiveOf = (leaf: string): unknown => HOSTED_EMBEDDING[leaf] ?? defaults.get(leaf) ?? null;
/** One leaf as the server answers it, marked retired as the server marks it (`RETIRED_LEAVES`). */
const rowFor = (leaf: string) => ({
  leaf, configured: false, value: null as unknown, updatedAt: null as number | null, updatedBy: null as string | null, retired: RETIRED_LEAVES.has(leaf),
  stored: null, effective: effectiveOf(leaf), effectiveValue: effectiveOf(leaf), source: effectiveOf(leaf) === null ? 'unset' : 'default', state: 'active', reason: null,
  appliesTo: leaf === 'embedding.base_url' ? ['bun'] : ['cloudflare', 'bun'], revision: '0',
});
/** The embedding picker's choices on a hosted server whose index holds bge-m3 vectors. */
const SWITCH = 'Switching the embedding model rebuilds search for every source. Choose Switch to this model to rebuild it in the background while search keeps using the current one';
const HOSTED_CHOICES = {
  target: 'cloudflare',
  providers: [
    { id: 'workers-ai', label: 'Cloudflare Workers AI', defaultModel: '@cf/baai/bge-m3', customModels: false, credential: null, endpoint: { editable: false, url: null },
      models: [{ id: '@cf/baai/bge-m3', dimensions: 1024, refusal: null, rebuilds: false }, { id: '@cf/baai/bge-base-en-v1.5', dimensions: 768, refusal: SWITCH, rebuilds: true }] },
    { id: 'openrouter', label: 'OpenRouter', defaultModel: 'openai/text-embedding-3-small', customModels: false, credential: 'openrouter', endpoint: { editable: false, url: 'https://openrouter.ai/api/v1' },
      models: [{ id: 'openai/text-embedding-3-small', dimensions: 1536, refusal: SWITCH, rebuilds: true }, { id: 'baai/bge-m3', dimensions: 1024, refusal: SWITCH, rebuilds: true }] },
  ],
  selection: { provider: 'workers-ai', model: '@cf/baai/bge-m3', endpoint: null, dimensions: 1024 },
  reason: null,
  held: [{ model: '@cf/baai/bge-m3', dimensions: 1024 }],
  capacity: 1536,
  switchable: false,
  switch: null as EmbeddingSwitchStatus | null,
};
/** A switch to bge-base under way on that server, 120 of 400 sources in. */
const BUILDING: EmbeddingSwitchStatus = {
  id: '6f1c2a90-3b7d-4e5f-8a1b-2c3d4e5f6a7b', provider: 'workers-ai', providerLabel: 'Cloudflare Workers AI', model: '@cf/baai/bge-base-en-v1.5', dimensions: 768,
  from: { model: '@cf/baai/bge-m3', dimensions: 1024 }, state: 'building', reason: null, done: 120, total: 400, startedAt: NOW - 5 * 60_000,
  estimatedTokens: 60_000, estimatedUsd: 0.004, retryAt: null, stalled: null, passedOver: { count: 0, sources: [] },
};
/** The same server before search has built anything: every model that fits may be chosen. */
const UNBUILT_CHOICES = {
  ...HOSTED_CHOICES,
  providers: HOSTED_CHOICES.providers.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m, refusal: null, rebuilds: false })) })),
  held: [],
  switchable: true,
};
/** The settings the page offers, and those it keeps under Older settings, as the server's flags decide. */
const LIVE_FIELDS = LEAF_FIELDS.filter((f) => !isRetired(f, rowFor(f.leaf)));
const RETIRED_FIELDS = [...RETIRED_LEAVES].map((leaf) => ({ leaf }));
const leaves = (over: Record<string, Partial<{ value: unknown; updatedBy: string; updatedAt: number; retired: boolean; editableValue: unknown; retiredValue: Record<string, unknown> }>> = {}) => ({
  embedding: HOSTED_CHOICES,
  taskTiers: OUTCOME_TASKS.map((task) => ({ task, tier: TASK_TIERS[task], source: 'task' })),
  leaves: DEPLOYMENT_LEAVES.map((leaf) => {
    const f = { leaf };
    const o = over[f.leaf];
    return { ...rowFor(f.leaf), ...(o?.value !== undefined ? { stored: o.value, effective: o.value, effectiveValue: o.value, source: 'configured' } : {}), editableValue: o?.editableValue, retiredValue: o?.retiredValue, configured: o?.value !== undefined, value: o?.value ?? null, updatedAt: o?.updatedAt ?? null, updatedBy: o?.updatedBy ?? null, retired: o?.retired ?? RETIRED_LEAVES.has(f.leaf) };
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

/** The element the selector names, or a throw that `waitFor` retries. */
function found(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`${selector} is not on the page`);
  return element;
}

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
          ? { ...row, source: 'invalid', state: 'invalid', error: 'invalid_value', remedy: 'Stored value is invalid. Correct it or reset this setting.' } : row),
      }),
      [`/api/settings/${leaf}`]: () => Response.json({ applied: true }),
    }));
    mount('/settings/models');
    await group('Codex tiers');
    expect(statusOf(leaf)).toContain('stored value does not apply');
    fireEvent.click(screen.getByRole('button', { name: 'Clear the stored value for High tier effort' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'DELETE', path: `/api/settings/${leaf}` });
  });

  it('shows the API effective value and neutral reason on each settings section, with one clear action', async () => {
    const changed = {
      'cortex.spores.inject_on_prompt_submit': { stored: false, effective: true, state: 'invalid', source: 'default', reason: 'The stored switch is invalid; spores are served.' },
      'agent.reasoning_map.claude-code.low': { stored: 'old-model', effective: 'haiku', state: 'not-applicable', source: 'default', reason: 'The stored model is unavailable; Haiku runs.' },
      'import.window_days': { stored: 99, effective: 7, state: 'inactive', source: 'task-override', reason: 'Importing past sessions is off.' },
      'backup.auto_interval_hours': { stored: 99, effective: 6, state: 'invalid', source: 'default', reason: 'The stored cadence is invalid; backups use six hours.' },
    };
    const { sent } = server(base({
      '/api/settings': () => Response.json({ ...leaves(), leaves: leaves().leaves.map((row) => {
        const change = changed[row.leaf as keyof typeof changed];
        return change === undefined ? row : { ...row, ...change, value: change.stored, effectiveValue: change.effective, configured: true, storedApplies: false };
      }) }),
      '/api/settings/import.window_days': () => Response.json({ applied: true }),
    }));
    mount('/settings');
    const spores = await screen.findByRole('switch', { name: 'Spores on every prompt' });
    expect(spores.getAttribute('aria-checked')).toBe('true');
    for (const [label, leaf, words] of [
      ['Myco’s work', 'cortex.spores.inject_on_prompt_submit', 'In use: on'],
      ['Models and keys', 'agent.reasoning_map.claude-code.low', 'In use: haiku'],
      ['Capture and retention', 'import.window_days', 'When active: 7 days'],
      ['Backups', 'backup.auto_interval_hours', 'In use: 6 hours'],
    ]) {
      await section(label!);
      await waitFor(() => expect(statusOf(leaf!)).toContain(words!));
      const status = document.querySelector(`[data-setting-status="${leaf}"]`)!;
      expect(status.getAttribute('role')).toBeNull();
      expect(status.className).not.toContain('text-bad');
      const control = within(status.closest('[data-setting]') as HTMLElement);
      expect(control.getAllByRole('button', { name: /Clear the stored value/ })).toHaveLength(1);
    }
    await section('Capture and retention');
    fireEvent.click(screen.getByRole('button', { name: 'Clear the stored value for Reach back at most' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'DELETE', path: '/api/settings/import.window_days' });
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
    expect(statusOf(leaf)).toBe('In use: Server login · server default');
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
    const input = tiers.getByLabelText('Low tier model');
    expect((input as HTMLInputElement).value).toBe('sonnet');
    fireEvent.change(input, { target: { value: 'haiku' } });
    fireEvent.blur(input);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: `/api/settings/${model}`, body: { value: 'haiku' } });
    fireEvent.click(tiers.getByRole('button', { name: 'Clear the stored value for Low tier model' }));
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
          // The fixture is a hosted server: a leaf it does not offer, with nothing stored, is not shown.
          const offered = rowFor(f.leaf).appliesTo.includes('cloudflare');
          expect({ leaf: f.leaf, present: within(card).queryByLabelText(f.label) !== null }).toEqual({ leaf: f.leaf, present: offered });
          controls += 1;
        }
      }
    }
    expect(controls).toBe(LIVE_FIELDS.length);
    await section('Myco’s work');
    await group('What sessions receive');
    // Nothing stored: the field shows the server's default in words, so the status says only that it is the default.
    expect(statusOf('cortex.spores.inject_on_prompt_submit')).toBe('In use: on · server default');
    expect(statusOf('agent.scheduled_tasks_active_window_days')).toBe('In use: 14 days · server default');
    expect(statusOf('agent.limits.concurrent_runs')).toBe('In use: none · not set');
    expect((screen.getByLabelText('Tasks at once') as HTMLInputElement).placeholder).toBe('Not set');
    expect(screen.queryByRole('region', { name: 'Older settings' })).toBeNull();
    expect(rawIdsIn(document.body, ['[data-testid="location"]'])).toEqual([]);
  });

  it('places every group in exactly one section, and leaves Sign-in and access to pointers', () => {
    expect(new Set(LEAF_GROUPS.map((g) => g.id)).size).toBe(LEAF_GROUPS.length);
    for (const g of LEAF_GROUPS) expect(SECTION_LABEL[g.section]).toBeDefined();
    expect(groupsOf('access')).toEqual([]);
    for (const id of ['work', 'models', 'capture', 'backups'] as const) expect(groupsOf(id).length).toBeGreaterThan(0);
  });

  it('saves a toggle on change and a typed leaf on blur, each to its own leaf', async () => {
    const { sent } = server(base({ '/api/settings/cortex.spores.inject_on_prompt_submit': () => Response.json({ applied: true }), '/api/settings/agent.scheduled_tasks_active_window_days': () => Response.json({ applied: true }) }));
    mount('/settings');
    // The server serves spores unless told not to, so with nothing stored the switch reads on, and a flip turns it off.
    const spores = await screen.findByRole('switch', { name: 'Spores on every prompt' });
    expect(spores.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(spores);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/settings/cortex.spores.inject_on_prompt_submit', body: { value: false } });
    const window = await screen.findByLabelText('Treat a project as active for');
    fireEvent.change(window, { target: { value: '30' } });
    fireEvent.blur(window);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'PUT', path: '/api/settings/agent.scheduled_tasks_active_window_days', body: { value: 30 } });
  });

  it('names the embedding search uses on a hosted server that stores nothing, and writes a provider only with the model chosen for it', async () => {
    const { sent } = server(base({
      '/api/settings': () => Response.json({ ...leaves(), embedding: UNBUILT_CHOICES }),
      '/api/embedding': () => Response.json({ applied: true }),
    }));
    mount('/settings/models');
    await screen.findByLabelText('Embedding provider');
    await waitFor(() => expect(statusOf('embedding.provider')).toBe('In use: Cloudflare Workers AI · bge-m3 (1024 dimensions)'));
    expect(screen.queryByLabelText('Embedding endpoint')).toBeNull();
    await pick('Embedding provider', 'OpenRouter');
    await waitFor(() => expect(statusOf('embedding.provider')).toContain('Choose a model below to switch search to OpenRouter.'));
    expect(sent).toEqual([]);
    await pick('Embedding model', 'baai/bge-m3 · 1024 dimensions');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/embedding', body: { provider: 'openrouter', model: 'baai/bge-m3' } });
    expect(Object.keys(sent[0]!.headers).some((h) => h.startsWith('x-myco-'))).toBe(false);
  });

  it('offers to switch to a model that rebuilds search, explains it, and starts the switch only once confirmed', async () => {
    let answerEstimate: () => void = () => undefined;
    let held = false;
    const { sent } = server(base({
      '/api/embedding': () => Response.json({ applied: true }),
      '/api/embedding/switch': () => Response.json({ applied: true, switch: BUILDING }),
    }));
    const routed = globalThis.fetch;
    // The estimate answers only when the test lets it, so the dialog is seen before it has the total.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(href, 'https://s').pathname !== '/api/embedding/switch/estimate') return routed(input, init);
      await routed(input, init);
      await new Promise<void>((resolve) => { answerEstimate = resolve; held = true; });
      return Response.json({ applied: true, estimate: { provider: 'openrouter', model: 'baai/bge-m3', sources: 4_812, estimatedTokens: 2_400_000, estimatedUsd: 0.024,
        passedOver: { count: 1, sources: [{ projectId: P_X, projectName: 'Project X', type: 'plan', title: 'Release checklist', reason: 'its stored text is missing', anyModel: true }] } } });
    }) as typeof fetch;
    mount('/settings/models');
    await waitFor(() => expect(statusOf('embedding.model')).toContain('Choosing another model offers to switch search to it'));
    await pick('Embedding provider', 'OpenRouter');
    await pick('Embedding model', 'baai/bge-m3 · 1024 dimensions · rebuilds search');
    const offer = await waitFor(() => found('[data-embedding-offer]'));
    expect(offer.textContent).toContain('bge-m3 rebuilds search: every source is read again with it, in the background. Search keeps working with bge-m3 meanwhile');
    expect(sent).toEqual([]);
    fireEvent.click(within(offer as HTMLElement).getByRole('button', { name: 'Switch to this model' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('OpenRouter charges $0.01 per million tokens');
    // Until the server's estimate is on the dialog, the switch cannot be confirmed.
    expect(dialog.textContent).toContain('Estimating what this switch reads and costs');
    expect((within(dialog).getByRole('button', { name: 'Switch to this model' }) as HTMLButtonElement).disabled).toBe(true);
    expect(sent).toEqual([{ method: 'POST', path: '/api/embedding/switch/estimate', body: { provider: 'openrouter', model: 'baai/bge-m3' }, headers: expect.any(Object) }]);
    await waitFor(() => expect(held).toBe(true));
    answerEstimate();
    await waitFor(() => expect(found('[data-switch-estimate]').textContent).toBe('It reads about 4,812 sources, about 2,400,000 tokens in all. Estimated cost: about $0.02.'));
    // The sources that will have no search by meaning are named before the switch can be agreed to.
    expect(within(dialog).getByText('This source has no search by meaning after the switch:')).toBeTruthy();
    expect(within(dialog).getByText('Plan “Release checklist” in Project X: its stored text is missing')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch to this model' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'POST', path: '/api/embedding/switch', body: { provider: 'openrouter', model: 'baai/bge-m3', confirm: true } });
  });

  it('keeps a switch from starting when the server cannot estimate it, and says so', async () => {
    const { sent } = server(base({
      '/api/embedding/switch/estimate': () => Response.json({ applied: false, reason: 'invalid_value', leaf: 'embedding.model', detail: 'No OpenRouter key is stored. Add one under Provider keys' }, { status: 400 }),
    }));
    mount('/settings/models');
    await waitFor(() => expect(statusOf('embedding.model')).toContain('Choosing another model offers to switch search to it'));
    await pick('Embedding provider', 'OpenRouter');
    await pick('Embedding model', 'baai/bge-m3 · 1024 dimensions · rebuilds search');
    fireEvent.click(within(await waitFor(() => found('[data-embedding-offer]'))).getByRole('button', { name: 'Switch to this model' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toContain('No OpenRouter key is stored. Add one under Provider keys.'));
    expect((within(dialog).getByRole('button', { name: 'Switch to this model' }) as HTMLButtonElement).disabled).toBe(true);
    expect(sent.map((r) => r.path)).toEqual(['/api/embedding/switch/estimate']);
  });

  it('reads Settings again while a switch stands, and stops once it ends', () => {
    expect(settingsRefreshInterval({ ...leaves(), embedding: { ...HOSTED_CHOICES, switch: BUILDING } } as unknown as Parameters<typeof settingsRefreshInterval>[0])).toBe(10_000);
    expect(settingsRefreshInterval({ ...leaves(), embedding: { ...HOSTED_CHOICES, switch: null } } as unknown as Parameters<typeof settingsRefreshInterval>[0])).toBe(false);
  });

  it('shows a switch that waits for its provider, one that has not moved, and the sources it left out, each saying why', async () => {
    const waiting: EmbeddingSwitchStatus = { ...BUILDING, retryAt: NOW + 4 * 60_000, reason: 'The new model\'s provider had a problem (HTTP 503). Myco tries again shortly.',
      stalled: 'Rebuilding search has not moved for 42 minutes: the last embedding run failed (“the provider timed out”).',
      passedOver: { count: 23, sources: [{ projectId: P_X, projectName: 'Project X', type: 'session', title: 'A very long session', reason: 'the model refused its text with HTTP 400', anyModel: false }] } };
    server(base({ '/api/settings': () => Response.json({ ...leaves(), embedding: { ...HOSTED_CHOICES, switch: waiting } }) }));
    mount('/settings/models');
    const panel = await waitFor(() => found('[data-embedding-waiting]'));
    expect(panel.textContent).toContain('Waiting');
    expect(panel.textContent).toMatch(/had a problem \(HTTP 503\)\. Myco tries again shortly\. Next try at \d{2}:\d{2}\./);
    expect(panel.textContent).toContain('Rebuilding search has not moved for 42 minutes: the last embedding run failed');
    expect(panel.textContent).toContain('23 sources will have no search by meaning once search moves to bge-base-en-v1.5:');
    expect(panel.textContent).toContain('Session “A very long session” in Project X: the model refused its text with HTTP 400');
    expect(panel.textContent).toContain('And 22 more sources.');
    // A model held off after a failure can be asked again at once.
    expect(within(panel).getByRole('button', { name: 'Try now' })).toBeTruthy();
  });

  it('shows a switch under way with its progress, what search uses meanwhile, and cancels it only once confirmed', async () => {
    const { sent } = server(base({
      '/api/settings': () => Response.json({ ...leaves(), embedding: { ...HOSTED_CHOICES, switch: BUILDING } }),
      [`/api/embedding/switch/${BUILDING.id}`]: () => Response.json({ applied: true, switch: null }),
    }));
    mount('/settings/models');
    const panel = await waitFor(() => found('[data-embedding-switch="building"]'));
    expect(panel.textContent).toContain('Rebuilding search with bge-base-en-v1.5 (768 dimensions): 120 of 400 sources done (30%).');
    expect(panel.textContent).toContain('Search keeps using bge-m3 until every source is done, then moves to bge-base-en-v1.5 on its own.');
    expect(panel.textContent).toContain('Estimated cost: under $0.01');
    expect((screen.getByLabelText('Embedding model') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(panel as HTMLElement).getByRole('button', { name: 'Cancel the switch' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Search keeps using bge-m3. The bge-base-en-v1.5 results built so far are removed.');
    expect(sent).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel the switch' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'DELETE', path: `/api/embedding/switch/${BUILDING.id}` });
  });

  it('shows a paused switch with its reason and resumes it', async () => {
    const paused = { ...BUILDING, state: 'paused' as const, reason: 'The new model\'s provider turned down its key (HTTP 401). Check the key under Provider keys, then resume.' };
    const { sent } = server(base({
      '/api/settings': () => Response.json({ ...leaves(), embedding: { ...HOSTED_CHOICES, switch: paused } }),
      [`/api/embedding/switch/${BUILDING.id}/resume`]: () => Response.json({ applied: true, switch: BUILDING }),
    }));
    mount('/settings/models');
    const panel = await waitFor(() => found('[data-embedding-switch="paused"]'));
    expect(panel.textContent).toContain('Rebuilding search with bge-base-en-v1.5 (768 dimensions) is paused at 120 of 400 sources done (30%).');
    expect(panel.textContent).toContain('HTTP 401');
    expect(panel.textContent).toContain('Search keeps using bge-m3 meanwhile.');
    fireEvent.click(within(panel as HTMLElement).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'POST', path: `/api/embedding/switch/${BUILDING.id}/resume` });
  });

  it('shows a stored provider this server does not offer as not in use, with its remedy and a reset', async () => {
    server(base({
      '/api/settings': () => Response.json({ ...leaves(), leaves: leaves().leaves.map((row) => row.leaf === 'embedding.provider'
        ? { ...row, configured: true, value: 'ollama', stored: 'ollama', state: 'not-applicable', reason: 'Ollama is not offered on Cloudflare; this server offers Cloudflare Workers AI, OpenRouter. Reset the provider to use Cloudflare Workers AI.' }
        : row) }),
    }));
    mount('/settings/models');
    await waitFor(() => expect(statusOf('embedding.provider')).toContain('Reset the provider'));
    expect(screen.getByRole('button', { name: 'Clear the stored value for Embedding provider' })).toBeTruthy();
    expect(statusOf('embedding.provider')).toContain('In use: Cloudflare Workers AI · bge-m3');
    expect(document.querySelector('[data-setting="embedding.provider"] [role="alert"]')).toBeNull();
  });

  it('shows a blank stored embedding model beside the running model and clears that leaf alone', async () => {
    const { sent } = server(base({
      '/api/settings': () => Response.json({ ...leaves(), leaves: leaves().leaves.map((row) => row.leaf === 'embedding.model'
        ? { ...row, configured: true, value: '', stored: '', storedApplies: false, state: 'invalid', reason: 'The blank stored model does not apply. Clear the stored value.' }
        : row) }),
    }));
    mount('/settings/models');
    await waitFor(() => expect(statusOf('embedding.model')).toContain('In use: Cloudflare Workers AI · bge-m3'));
    expect(statusOf('embedding.model')).toContain('blank stored model');
    expect(document.querySelector('[data-setting="embedding.model"] [role="alert"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the stored value for Embedding model' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'DELETE', path: '/api/settings/embedding.model' });
  });

  it('says the refusal in the person\'s words: a foreign leaf is named as not held, any other refusal carries its status, and a bad number never leaves', async () => {
    const { sent } = server(base({
      '/api/settings/cortex.spores.inject_on_prompt_submit': () => Response.json({ applied: false, reason: 'not_deployment_tier', leaf: 'cortex.spores.inject_on_prompt_submit' }, { status: 400 }),
      '/api/settings/agent.scheduled_tasks_active_window_days': () => Response.json({ error: 'nope' }, { status: 503 }),
    }));
    mount('/settings');
    fireEvent.click(await screen.findByRole('switch', { name: 'Spores on every prompt' }));
    await waitFor(() => expect(statusOf('cortex.spores.inject_on_prompt_submit')).toBe('That setting is not held by the server.'));
    const limit = await screen.findByLabelText('Items per prompt');
    fireEvent.change(limit, { target: { value: '11' } });
    fireEvent.blur(limit);
    await waitFor(() => expect(statusOf('cortex.spores.max_per_prompt')).toBe('Enter a number from 0 to 10.'));
    const window = await screen.findByLabelText('Treat a project as active for');
    fireEvent.change(window, { target: { value: '20' } });
    fireEvent.blur(window);
    await waitFor(() => expect(statusOf('agent.scheduled_tasks_active_window_days')).toBe('The server refused (503).'));
    expect(sent.map((s) => s.path)).toEqual(['/api/settings/cortex.spores.inject_on_prompt_submit', '/api/settings/agent.scheduled_tasks_active_window_days']);
  });


  it('saves the task overrides document on Save, and refuses one that is not JSON before it leaves', async () => {
    const { sent } = server(base({ '/api/settings/agent.tasks': () => Response.json({ applied: true }) }));
    mount('/settings/models');
    const doc = await screen.findByLabelText('Task overrides');
    const row = doc.closest('[data-setting]') as HTMLElement;
    fireEvent.change(doc, { target: { value: '{"title-summary":' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(statusOf('agent.tasks')).toBe('Enter the overrides as an object in braces, keyed by task name.'));
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
    await waitFor(() => expect(statusOf('worker.harness')).toBe('In use: none · not set'));
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
      '/api/settings': () => Response.json(leaves(Object.fromEntries(Object.entries(held).map(([leaf, value]) => [leaf, { value, updatedAt: NOW, updatedBy: ADA }])))),
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
  it('offers no retired settings or Older settings surface', async () => {
    expect(RETIRED_LEAVES.size).toBe(0);
    server(base());
    mount('/settings');
    await group('What sessions receive');
    expect(screen.queryByRole('region', { name: 'Older settings' })).toBeNull();
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
    mount('/settings/models');
    expect(screen.queryByRole('region', { name: 'Older settings' })).toBeNull();
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
    expect(statusOf('cortex.instructions.inject_on_session_start')).toBe('In use: on · server default');
    expect(statusOf('agent.scheduled_tasks_enabled')).toBe('In use: off · server default');
  });

  it('says what the server said was wrong with a value it refused', async () => {
    server(base({ '/api/settings/cortex.spores.max_per_prompt': () => Response.json({ applied: false, reason: 'invalid_value', leaf: 'cortex.spores.max_per_prompt', detail: 'expected a whole number' }, { status: 400 }) }));
    mount('/settings');
    const limit = await screen.findByLabelText('Items per prompt');
    fireEvent.change(limit, { target: { value: '3' } });
    fireEvent.blur(limit);
    await waitFor(() => expect(statusOf('cortex.spores.max_per_prompt')).toBe('The server refused that value: expected a whole number.'));
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

describe('choosing a tier\'s model from the models the machines listed', () => {
  const listed = (harness: string, models: Array<Record<string, unknown>>) => ({ harness, source: { kind: 'command', command: harness }, signIn: 'worker-login', fetchedAt: NOW - 3_600_000, receivedAt: NOW - 3_600_000, models });
  const CLAUDE = listed('claude-code', [
    { id: 'haiku', label: 'Haiku 4.5', resolvesTo: 'claude-haiku-4-5-20251001' },
    { id: 'sonnet', label: 'Sonnet 5.5', resolvesTo: 'claude-sonnet-5-5' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  ]);
  const CODEX = listed('codex', [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', isDefault: true },
    { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
    { id: 'gpt-5.5', label: 'GPT-5.5', upgrade: 'gpt-6-sol' },
  ]);
  const OPENROUTER_LATEST = ['haiku', 'sonnet', 'opus'].map((family) => `openrouter/~anthropic/claude-${family}-latest`);
  const openCode = (ids: string[]) => listed('opencode', ids.map((id) => ({ id, label: id, provider: id.slice(0, id.indexOf('/')) })));
  type Over = Parameters<typeof leaves>[0];
  const withModels = (models: unknown[], over: Over = {}, rows: (row: ReturnType<typeof leaves>['leaves'][number]) => object = (row) => row) => () => {
    const answer = leaves(over);
    return Response.json({ ...answer, leaves: answer.leaves.map(rows), models });
  };
  const optionWords = async () => (await screen.findAllByRole('option')).map((option) => option.textContent);

  it('picks a listed model and writes its id; an alias the agent resolves reads as the newest of its family, and what it is now', async () => {
    const leaf = 'agent.reasoning_map.claude-code.low';
    const { sent } = server(base({ '/api/settings': withModels([CLAUDE]), [`/api/settings/${leaf}`]: () => Response.json({ applied: true }) }));
    mount('/settings/models');
    const claude = within(await group('Claude Code tiers'));
    expect(claude.getAllByText(/^Models listed by your machines/)).toHaveLength(1);
    expect(document.querySelector('[data-model-listing="claude-code"]')?.textContent).toContain('Models listed by your machines 1 h ago, each with its own sign-in to Claude Code.');
    expect(statusOf(leaf)).toBe('In use: haiku · server default');
    fireEvent.click(claude.getByLabelText('Low tier model'));
    expect(await optionWords()).toEqual(['haiku: newest Haiku (now Haiku 4.5)', 'sonnet: newest Sonnet (now Sonnet 5.5)', 'Opus 4.8 (claude-opus-4-8)']);
    fireEvent.click(await screen.findByRole('option', { name: 'sonnet: newest Sonnet (now Sonnet 5.5)' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: `/api/settings/${leaf}`, body: { value: 'sonnet' } });
  });

  it('says whose login the list came from where runs sign in with the server login instead', async () => {
    const credential = 'agent.harnesses.codex.credential';
    server(base({ '/api/settings': withModels([CODEX], {}, (row) => (row.leaf === credential ? { ...row, effective: 'deployment', effectiveValue: 'deployment', source: 'default' } : row)) }));
    mount('/settings/models');
    await group('Codex tiers');
    expect(document.querySelector('[data-model-listing="codex"]')?.textContent)
      .toBe('Models listed by your machines 1 h ago, each with its own sign-in to Codex. Runs sign in with the server login, which may offer different models.');
  });

  it('keeps a stored model no machine listed, and says so in plain words', async () => {
    const leaf = 'agent.reasoning_map.claude-code.high';
    server(base({ '/api/settings': withModels([CLAUDE], { [leaf]: { value: 'claude-opus-4-1', updatedBy: ADA, updatedAt: NOW } }) }));
    mount('/settings/models');
    await group('Claude Code tiers');
    expect(statusOf(leaf)).toContain('claude-opus-4-1 is not among the models your machines listed for Claude Code.');
    fireEvent.click(within(await group('Claude Code tiers')).getByLabelText('High tier model'));
    expect((await optionWords())[0]).toBe('claude-opus-4-1 (not listed)');
  });

  it('names a stored model\'s successor where the agent names one, and switches to it', async () => {
    const leaf = 'agent.reasoning_map.codex.high';
    const { sent } = server(base({
      '/api/settings': withModels([CODEX], { [leaf]: { value: 'gpt-5.5', updatedBy: ADA, updatedAt: NOW } }),
      [`/api/settings/${leaf}`]: () => Response.json({ applied: true }),
    }));
    mount('/settings/models');
    const codex = within(await group('Codex tiers'));
    expect(statusOf(leaf)).toContain('Codex names GPT-6-Sol as the successor to GPT-5.5.');
    fireEvent.click(codex.getByRole('button', { name: 'Use GPT-6-Sol' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: `/api/settings/${leaf}`, body: { value: 'gpt-6-sol' } });
  });

  it('narrows a list to one provider by its name, and keeps the stored model shown whichever provider is chosen', async () => {
    const leaf = 'agent.reasoning_map.opencode.default';
    server(base({ '/api/settings': withModels([openCode(['openai/gpt-6', 'opencode/big-pickle', ...OPENROUTER_LATEST])], { [leaf]: { value: 'openai/gpt-6', updatedBy: ADA, updatedAt: NOW } }) }));
    mount('/settings/models');
    const opencode = within(await group('OpenCode tiers'));
    fireEvent.click(opencode.getByLabelText('Default tier model provider'));
    expect(await optionWords()).toEqual(['All providers', 'OpenAI', 'OpenCode Zen', 'OpenRouter']);
    fireEvent.click(await screen.findByRole('option', { name: 'OpenRouter' }));
    await waitFor(() => expect(screen.queryByRole('option')).toBeNull());
    expect(opencode.getByLabelText('Default tier model').textContent).toContain('openai/gpt-6');
    fireEvent.click(opencode.getByLabelText('Default tier model'));
    expect(await optionWords()).toEqual(['openai/gpt-6', ...OPENROUTER_LATEST]);
  });

  it('marks the model the agent runs when none is named, and says what an unset tier means', async () => {
    server(base({ '/api/settings': withModels([CODEX]) }));
    mount('/settings/models');
    await group('Codex tiers');
    expect(statusOf('agent.reasoning_map.codex.low')).toContain('In use: none');
    fireEvent.click(within(await group('Codex tiers')).getByLabelText('Low tier model'));
    expect((await optionWords())[0]).toBe('GPT-6.1-Sol (gpt-6.1-sol), Codex’s default');
  });

  it('says what an unset tier means where the model is typed, too', async () => {
    server(base({ '/api/settings': withModels([]) }));
    mount('/settings/models');
    await group('Codex tiers');
    expect(statusOf('agent.reasoning_map.codex.low')).toContain('In use: none');
  });

  it('offers a preset in plain words where a machine lists all its models, and applies it tier by tier through the same write', async () => {
    const tiers = ['low', 'default', 'high'].map((tier) => `agent.reasoning_map.opencode.${tier}`);
    const { sent } = server(base({
      '/api/settings': withModels([openCode(['openai/gpt-6', ...OPENROUTER_LATEST])]),
      ...Object.fromEntries(tiers.map((leaf) => [`/api/settings/${leaf}`, () => Response.json({ applied: true })])),
    }));
    mount('/settings/models');
    const opencode = within(await group('OpenCode tiers'));
    expect(opencode.getByText('Newest Claude through OpenRouter')).toBeTruthy();
    expect(opencode.getByText('Haiku, Sonnet and Opus through OpenRouter, always the newest version. Offered because your machines’ OpenCode lists these models from OpenRouter.')).toBeTruthy();
    fireEvent.click(opencode.getByRole('button', { name: 'Model IDs' }));
    expect(opencode.getByText(`High: ${OPENROUTER_LATEST[2]}`)).toBeTruthy();
    fireEvent.click(opencode.getByRole('button', { name: 'Use these models' }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((s) => ({ method: s.method, path: s.path, body: s.body }))).toEqual(tiers.map((leaf, i) => ({ method: 'PUT', path: `/api/settings/${leaf}`, body: { value: OPENROUTER_LATEST[i] } })));
    expect(await opencode.findByText('Every tier now uses these models.')).toBeTruthy();
  });

  it('offers no preset where no machine lists its models', async () => {
    server(base({ '/api/settings': withModels([openCode(['openai/gpt-6', 'github-copilot/claude-opus-5.5'])]) }));
    mount('/settings/models');
    expect(within(await group('OpenCode tiers')).queryByRole('button', { name: 'Use these models' })).toBeNull();
  });

  it('types a model where no machine has listed the agent\'s models, or where the person asks to', async () => {
    server(base({ '/api/settings': withModels([CLAUDE]) }));
    mount('/settings/models');
    const codex = within(await group('Codex tiers'));
    expect(codex.getByLabelText('Low tier model').tagName).toBe('INPUT');
    expect(document.querySelector('[data-model-listing="codex"]')).toBeNull();
    const claude = within(await group('Claude Code tiers'));
    expect(claude.getByLabelText('Low tier model').tagName).toBe('BUTTON');
    fireEvent.click(claude.getAllByRole('button', { name: 'Type a model name' })[0]!);
    expect(claude.getByLabelText('Low tier model').tagName).toBe('INPUT');
  });
});
