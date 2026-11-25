/**
 * Settings: what the server holds for every member, in six sections, each
 * change written to its own leaf, the provider keys never shown after they are
 * stored, titling imported sessions as a switch, the short lists of people,
 * machines and repositories leading to their pages, and everything else folded
 * under Advanced.
 */
import { dashboardMe } from '../helpers/dashboard-permissions';
import { beforeAll, afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { ADVANCED_FOLDS, LEAF_FIELDS, LEAF_GROUPS, groupsOf } from '../../packages/myco-server/ui/src/features/admin/settings/catalogue';
import { agentListRefusal, deadlineWords, LeafControl, savedWords, WORKER_AGENTS } from '../../packages/myco-server/ui/src/features/admin/settings/LeafControl';
import { isRetired } from '../../packages/myco-server/ui/src/features/admin/settings/retired';
import { effectiveSettings } from '../../packages/myco-server/src/core/settings-policies';
import { sqliteEnv } from '../myco-server/helpers/fixtures';
import { DEPLOYMENT_LEAVES, RETIRED_LEAVES } from '../../packages/myco-server/src/core/settings';
import { oldTabTarget } from '../../packages/myco-server/ui/src/features/admin/settings/SettingsPage';
import { liftsAt, policyWords, progressWords, waitingWords } from '../../packages/myco-server/ui/src/features/admin/settings/titling';
import { SETTINGS_SECTIONS } from '../../packages/myco-server/ui/src/routes/nav';
import { OUTCOME_TASKS, TASK_TIERS, TASK_WORDS, type RetainedTask } from '../../packages/myco-server/src/core/task-catalogue';

const taskName = (task: string): string => TASK_WORDS[task as RetainedTask].name;
import { rawIdsIn } from '../helpers/raw-ids';
import { settingsMoving } from '../../packages/myco-server/ui/src/hooks/use-settings';
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
  from: { model: '@cf/baai/bge-m3', dimensions: 1024 }, state: 'building', reason: null, done: 120, total: 400, progress: 'ready', asOf: NOW, startedAt: NOW - 5 * 60_000,
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
/** Who answers quick jobs on a hosted server that stores no address. */
const HOSTED_QUICK_JOBS = { answeredBy: 'included', offered: ['included', 'address'] };
const leaves = (over: Record<string, Partial<{ value: unknown; revision: string; updatedBy: string; updatedAt: number; retired: boolean; editableValue: unknown; retiredValue: Record<string, unknown> }>> = {}) => ({
  embedding: HOSTED_CHOICES,
  quickJobs: HOSTED_QUICK_JOBS,
  taskTiers: OUTCOME_TASKS.map((task) => ({ task, name: taskName(task), tier: TASK_TIERS[task], source: 'task' })),
  leaves: DEPLOYMENT_LEAVES.map((leaf) => {
    const f = { leaf };
    const o = over[f.leaf];
    return { ...rowFor(f.leaf), revision: o?.revision ?? '0', ...(o?.value !== undefined ? { stored: o.value, effective: o.value, effectiveValue: o.value, source: 'configured' } : {}), editableValue: o?.editableValue, retiredValue: o?.retiredValue, configured: o?.value !== undefined, value: o?.value ?? null, updatedAt: o?.updatedAt ?? null, updatedBy: o?.updatedBy ?? null, retired: o?.retired ?? RETIRED_LEAVES.has(f.leaf) };
  }),
});
const secrets = (anthropicConfigured: boolean) => ({ secrets: [
  { name: 'anthropic', configured: anthropicConfigured, readable: true, maskedValue: anthropicConfigured ? 's…c' : null, kind: anthropicConfigured ? 'subscription' : null, updatedAt: anthropicConfigured ? NOW : null, updatedBy: anthropicConfigured ? ADA : null },
  { name: 'codex', configured: false, readable: true, maskedValue: null, kind: null, updatedAt: null, updatedBy: null },
  { name: 'openai', configured: false, readable: true, maskedValue: null, kind: null, updatedAt: null, updatedBy: null },
  { name: 'openrouter', configured: false, readable: true, maskedValue: null, kind: null, updatedAt: null, updatedBy: null },
] });
type Choice = 'own' | 'stored' | null;
/** `GET /api/runners/agents`: each agent offered, with the runners offering it and what each pays with, and the agent each uses today. */
const payers = (agents: Array<{ agent: string; storedUsable?: boolean; runners: Array<[id: string, name: string, choice: Choice]> }>, today: Array<[id: string, name: string, agent: string | null]> = []) => ({
  agents: agents.map(({ agent, storedUsable = false, runners }) => ({ agent, storedUsable, runners: runners.map(([id, name, choice]) => ({ id, name, choice })) })),
  today: today.map(([id, name, agent]) => ({ id, name, agent })),
});
/** One runner offering the agents whose model sizes Models lists, each paid by its own sign-in. */
const ONE_RUNNER = payers(['claude-code', 'codex', 'opencode'].map((agent) => ({ agent, runners: [['rn_mini', 'homelab-mini', 'own'] as [string, string, Choice]] })), [['rn_mini', 'homelab-mini', 'claude-code']]);
const TITLING = { scheduledTasksEnabled: true, backfillEnabled: true, runsPerDay: 24, intervalSeconds: 900, runIn: ['active', 'idle'], overlap: 'queue', enabled: true, building: false, remaining: 12, owed: 0, usedToday: 3, inFlight: 1, completedToday: 2, failedToday: 0, waiting: null };

interface Sent { method: string; path: string; body: unknown; headers: Record<string, string> }
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(routes: Record<string, (init?: RequestInit, url?: URL) => Response | Promise<Response>>): { sent: Sent[] } {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    const pathname = url.pathname;
    const method = init?.method ?? 'GET';
    if (method !== 'GET') sent.push({ method, path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})) });
    return routes[pathname]?.(init, url) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { sent };
}

/** `GET /api/github-app` for a hosted Deployment whose App GitHub's public page identified before any key. */
const APP_OWNER = { login: 'goondocks-co', type: 'Organization' as const };
const SETUP = { target: 'cloudflare', origin: null, clientId: 'Iv1.app', expectedName: null, lookupError: null, key: { state: 'key_absent' }, installations: null, connectedProjects: 0, repository: null,
  app: { slug: 'myco-app', name: 'Myco (app)', owner: APP_OWNER, permissions: { contents: 'read', pull_requests: 'read', metadata: 'read' }, source: 'public' } };
const KEYED = { ...SETUP, key: { state: 'ready', app: { slug: 'myco-app' }, missing: [] } };
const INSTALLED = { installationId: 41, account: APP_OWNER, approved: false, suspended: false, permissionsAccepted: true };

const base = (extra: Record<string, (init?: RequestInit, url?: URL) => Response | Promise<Response>> = {}) => ({
  '/auth/me': () => Response.json(dashboardMe(ME)),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/members': () => Response.json(MEMBERS),
  '/api/github-app': () => Response.json(SETUP),
  '/api/settings': () => Response.json(leaves({ 'cortex.digest.inject_on_session_start': { value: true, updatedBy: ADA, updatedAt: NOW - 2 * 3_600_000 } })),
  '/api/secrets': () => Response.json(secrets(true)),
  '/api/titling-backfill': () => Response.json(TITLING),
  '/api/runners/agents': () => Response.json(ONE_RUNNER),
  '/api/telemetry/keys': () => Response.json({ endpoint: 'https://myco.example', keys: [] }),
  '/api/repositories': () => Response.json({ repositories: [], cursor: null }),
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
  fireEvent.click(await screen.findByLabelText(new RegExp(`^${label}(?::|$)`)));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

function Where() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</span>;
}

function mount(path: string, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const proto = window.HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
  proto.scrollIntoView ??= () => undefined;
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /><Where /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

const location = () => screen.getByTestId('location').textContent;
/** Opens Advanced with every group unfolded. */
async function mountAdvanced(hash = '') {
  mount(`/settings/advanced${hash}`);
  await waitFor(() => expect(document.querySelectorAll('[data-fold]')).toHaveLength(ADVANCED_FOLDS.length));
  for (const fold of document.querySelectorAll<HTMLElement>('[data-fold] > div > button[aria-expanded="false"]')) fireEvent.click(fold);
}
const sectionsNav = () => screen.findByRole('navigation', { name: 'Settings sections' });
/** Opens a section from the tab strip. */
async function section(label: string) {
  fireEvent.click(within(await sectionsNav()).getByRole('link', { name: label }));
  await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('link', { name: label }).getAttribute('aria-current')).toBe('page'));
}
/** The Advanced group each folded settings group sits in, by label. */
const FOLD_OF = new Map<string, string>([
  ...LEAF_GROUPS.flatMap((g) => (g.fold === undefined ? [] : [[g.label, ADVANCED_FOLDS.find((f) => f.id === g.fold)!.label] as [string, string]])),
  ['Size of each job', 'Model sizes'],
]);
/** A settings group's card by its label, opening its fold under Advanced first where it is folded. */
const group = (label: string) => waitFor(() => {
  const open = screen.queryByRole('group', { name: label });
  if (open !== null) return open;
  const names = [label, FOLD_OF.get(label)].filter((name): name is string => name !== undefined);
  const fold = screen.queryAllByRole('button').find((button) => button.getAttribute('aria-expanded') === 'false' && names.some((name) => button.textContent?.startsWith(name)));
  if (fold !== undefined) fireEvent.click(fold);
  throw new Error(`${label} is not open yet`);
});
/** One row of Connections by its name. */
const connection = (label: string): HTMLElement => {
  const row = screen.getAllByText(label).map((element) => element.closest<HTMLElement>('[data-connection]')).find((element) => element !== null);
  if (row === undefined || row === null) throw new Error(`${label} is not a connection on the page`);
  return row;
};
const statusOf = (leaf: string) => document.querySelector(`[data-setting-status="${leaf}"]`)?.textContent;
const SECTION_LABEL = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s.id, s.label])) as Record<string, string>;
/** The groups Models shows through its own steps rather than as a card of fields: quick jobs and the agent. */
const OWN_GROUPS = groupsOf('models').filter((g) => g.id !== 'embedding');

describe('Settings, in six sections', () => {
  it('names tasks in user words and offers a repair for a stored invalid tier', async () => {
    const { sent } = server(base({
      '/api/settings': () => Response.json({
        ...leaves(),
        taskTiers: OUTCOME_TASKS.map((task) => task === 'title-summary'
          ? { task, name: taskName(task), tier: null, source: 'invalid', error: 'invalid_task_tier', repair: 'reset-task', remedy: 'Correct the tier in Settings or reset the task tier.' }
          : { task, name: taskName(task), tier: TASK_TIERS[task], source: 'task' }),
      }),
      '/api/settings/agent.tasks': () => Response.json({ applied: true }),
    }));
    mount('/settings/advanced#model-sizes');
    const editor = within(await group('Size of each job'));
    const labels = OUTCOME_TASKS.map((task) => editor.getByRole('combobox', { name: new RegExp(`^${taskName(task)} size(?::|$)`) }));
    expect(labels).toHaveLength(OUTCOME_TASKS.length);
    expect(editor.getByText('Curate overlapping spores')).toBeTruthy();
    expect(editor.getByText('Curate stale plans')).toBeTruthy();
    expect(editor.queryByText('A task')).toBeNull();
    expect(statusOf('task-tier-title-summary')).toContain('Correct the tier in Settings or reset the task tier.');
    fireEvent.click(editor.getByRole('button', { name: 'Reset Title and summarize sessions size' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PATCH', path: '/api/settings/agent.tasks', body: { task: 'title-summary', tier: null } });
    expect(LEAF_GROUPS.filter((g) => g.fold === 'model-sizes')[0]?.id).toBe('claude-profile');
    expect(LEAF_GROUPS.findIndex((group) => group.id === 'claude-profile')).toBeLessThan(LEAF_GROUPS.findIndex((group) => group.id === 'codex-profile'));
  });

  it('offers a whole-document reset when task overrides are malformed', async () => {
    const { sent } = server(base({
      '/api/settings': () => Response.json({
        ...leaves({ 'agent.tasks': { value: [] } }),
        taskTiers: OUTCOME_TASKS.map((task) => ({ task, name: taskName(task), tier: null, source: 'invalid', error: 'invalid_task_tier', repair: 'reset-leaf', remedy: 'Reset task overrides to restore defaults.' })),
      }),
      '/api/settings/agent.tasks': () => Response.json({ applied: true }),
    }));
    mount('/settings/advanced#model-sizes');
    const editor = within(await group('Size of each job'));
    expect(editor.queryByRole('button', { name: 'Reset Title and summarize sessions size' })).toBeNull();
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
    mount('/settings/advanced#model-sizes');
    await group('Codex model sizes');
    expect(statusOf(leaf)).toContain('stored value does not apply');
    fireEvent.click(screen.getByRole('button', { name: 'Clear the stored value for Large jobs effort' }));
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
    await mountAdvanced();
    const spores = await screen.findByRole('switch', { name: 'Spores on every prompt' });
    expect(spores.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/Each hosted backup pauses database requests/).textContent).toContain('larger databases take longer');
    for (const [leaf, words] of [
      ['cortex.spores.inject_on_prompt_submit', 'This setting is on'],
      ['agent.reasoning_map.claude-code.low', 'Myco uses haiku'],
      ['import.window_days', 'When active, Myco uses 7 days'],
      ['backup.auto_interval_hours', 'Myco uses 6 hours'],
    ]) {
      await waitFor(() => expect(statusOf(leaf!)).toContain(words!));
      const status = document.querySelector(`[data-setting-status="${leaf}"]`)!;
      expect(status.getAttribute('role')).toBeNull();
      expect(status.className).not.toContain('text-bad');
      const control = within(status.closest('[data-setting]') as HTMLElement);
      expect(control.getAllByRole('button', { name: /Clear the stored value/ })).toHaveLength(1);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Clear the stored value for Reach back at most' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'DELETE', path: '/api/settings/import.window_days' });
  });

  it('shows login choices in user words while saving their wire values', async () => {
    const leaf = 'agent.harnesses.claude-code.credential';
    const { sent } = server(base({
      '/api/settings': () => Response.json({ ...leaves(), leaves: leaves().leaves.map((row) => row.leaf === leaf
        ? { ...row, effective: 'deployment', effectiveValue: 'deployment', source: 'default' } : row) }),
      [`/api/settings/${leaf}`]: () => Response.json({ applied: true }),
    }));
    mount('/settings/advanced#model-sizes');
    const claude = within(await group('Claude Code model sizes'));
    expect(claude.getByLabelText('Legacy workers sign in with')).toBeTruthy();
    expect(statusOf(leaf)).toBe('Myco uses The server’s stored key (server default).');
    fireEvent.click(claude.getByLabelText('Legacy workers sign in with'));
    fireEvent.click(await screen.findByRole('option', { name: 'This machine’s sign-in' }));
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
          return { task, name: taskName(task), tier: override?.reasoningLevel ?? TASK_TIERS[task], source: override?.reasoningLevel ? 'task-override' : 'task' };
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
    mount('/settings/advanced#model-sizes');
    const editor = within(await group('Size of each job'));
    expect(editor.getByText('Changed for this task')).toBeTruthy();
    document = {
      'title-summary': { reasoningLevel: 'low', schedule: { maxRunsPerDay: 7 }, harness: 'claude-code', model: 'sonnet' },
      'canopy-map': { schedule: { intervalSeconds: 900 }, harness: 'codex' },
    };
    await pick('Title and summarize sessions size', 'Large');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PATCH', path: '/api/settings/agent.tasks', body: { task: 'title-summary', tier: 'high' } });
    expect(document).toEqual({
      'title-summary': { reasoningLevel: 'high', schedule: { maxRunsPerDay: 7 }, harness: 'claude-code', model: 'sonnet' },
      'canopy-map': { schedule: { intervalSeconds: 900 }, harness: 'codex' },
    });
    fireEvent.click(editor.getByRole('button', { name: 'Reset Title and summarize sessions size' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'PATCH', path: '/api/settings/agent.tasks', body: { task: 'title-summary', tier: null } });
    expect(document).toEqual({
      'title-summary': { schedule: { maxRunsPerDay: 7 }, harness: 'claude-code', model: 'sonnet' },
      'canopy-map': { schedule: { intervalSeconds: 900 }, harness: 'codex' },
    });
    await waitFor(() => expect(statusOf('task-tier-title-summary')).toBe('Declared size'));
  });

  it('edits a tier model and resets that leaf alone', async () => {
    const model = 'agent.reasoning_map.claude-code.low';
    const { sent } = server(base({
      '/api/settings': () => Response.json(leaves({ [model]: { value: 'sonnet', updatedBy: ADA, updatedAt: NOW } })),
      [`/api/settings/${model}`]: () => Response.json({ applied: true }),
    }));
    mount('/settings/advanced#model-sizes');
    const tiers = within(await group('Claude Code model sizes'));
    const input = tiers.getByLabelText('Small jobs model');
    expect((input as HTMLInputElement).value).toBe('sonnet');
    fireEvent.change(input, { target: { value: 'haiku' } });
    fireEvent.blur(input);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: `/api/settings/${model}`, body: { value: 'haiku' } });
    fireEvent.click(tiers.getByRole('button', { name: 'Clear the stored value for Small jobs model' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'DELETE', path: `/api/settings/${model}` });
  });

  it('lists the sections as one strip of tabs, each at its own address, the first current on /settings', async () => {
    server(base());
    mount('/settings');
    const nav = await sectionsNav();
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Myco’s work', 'People and machines', 'Repositories', 'Models', 'Connections', 'Advanced']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/settings', '/settings/people', '/settings/repositories', '/settings/models', '/settings/connections', '/settings/advanced']);
    expect(links[0]!.getAttribute('aria-current')).toBe('page');
    // The strip never wraps: it scrolls in its own box.
    expect(nav.className).toContain('overflow-x-auto');
    await section('Advanced');
    expect(location()).toBe('/settings/advanced');
    expect(await group('Backups')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Should Myco work on its own?' })).toBeNull();
  });

  it('renders a control for every catalogued leaf across the sections, and names who saved a configured one, never by id', async () => {
    server(base());
    mount('/settings');
    let controls = 0;
    for (const s of SETTINGS_SECTIONS) {
      const groups = groupsOf(s.id).filter((g) => !OWN_GROUPS.includes(g));
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
    expect(controls).toBe(LIVE_FIELDS.filter((f) => !OWN_GROUPS.some((g) => g.leaves.includes(f))).length);
    await section('Advanced');
    await group('What sessions receive');
    await group('How much at once');
    // Nothing stored: the field shows the server's default in words, so the status says only that it is the default.
    expect(statusOf('cortex.spores.inject_on_prompt_submit')).toBe('This setting is on (server default).');
    expect(statusOf('agent.scheduled_tasks_active_window_days')).toBe('Myco uses 14 days (server default).');
    expect(statusOf('agent.limits.concurrent_runs')).toBe('Myco uses no limit (not set).');
    expect((screen.getByLabelText('Tasks at once') as HTMLInputElement).placeholder).toBe('No limit');
    expect(screen.queryByRole('region', { name: 'Older settings' })).toBeNull();
    expect(rawIdsIn(document.body, ['[data-testid="location"]'])).toEqual([]);
  });

  it('places every group in exactly one section, each under Advanced in one of its groups, and leaves the lists to their own rows', () => {
    expect(new Set(LEAF_GROUPS.map((g) => g.id)).size).toBe(LEAF_GROUPS.length);
    for (const g of LEAF_GROUPS) expect(SECTION_LABEL[g.section]).toBeDefined();
    for (const id of ['people', 'repositories', 'connections'] as const) expect(groupsOf(id)).toEqual([]);
    for (const id of ['work', 'models', 'advanced'] as const) expect(groupsOf(id).length).toBeGreaterThan(0);
    for (const g of LEAF_GROUPS) expect({ group: g.id, folded: g.fold !== undefined }).toEqual({ group: g.id, folded: g.section === 'advanced' });
  });

  it('saves a toggle on change and a typed leaf on blur, each to its own leaf', async () => {
    const { sent } = server(base({ '/api/settings/cortex.spores.inject_on_prompt_submit': () => Response.json({ applied: true }), '/api/settings/agent.scheduled_tasks_active_window_days': () => Response.json({ applied: true }) }));
    await mountAdvanced();
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
    mount('/settings/models#embedding');
    await screen.findByLabelText('Embedding provider');
    await waitFor(() => expect(statusOf('embedding.provider')).toBe('Search uses Cloudflare Workers AI with bge-m3 (1024 dimensions).'));
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
        passedOver: { count: 1, sources: [{ projectId: P_X, projectName: 'Project X', type: 'plan', title: 'Release checklist', reason: 'its stored text is missing', anyModel: true }] }, progress: 'ready' } });
    }) as typeof fetch;
    mount('/settings/models#embedding');
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
    mount('/settings/models#embedding');
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
    expect(settingsMoving({ ...leaves(), embedding: { ...HOSTED_CHOICES, switch: BUILDING } } as unknown as Parameters<typeof settingsMoving>[0])).toBe(true);
    expect(settingsMoving({ ...leaves(), embedding: { ...HOSTED_CHOICES, switch: null } } as unknown as Parameters<typeof settingsMoving>[0])).toBe(false);
  });

  it('reads Settings again while a changed quiet time is reaching sessions, and says what is in effect only until it has', () => {
    const answer = (rebuilding: boolean) => ({ ...leaves(), embedding: { ...HOSTED_CHOICES, switch: null }, leaves: [{ leaf: 'agent.titling_idle_close_minutes', learningDeadlines: { configured: 60, pending: rebuilding ? 60 : null, effective: rebuilding ? 120 : 60, rebuilding } }] }) as unknown as Parameters<typeof settingsMoving>[0];
    expect(settingsMoving(answer(true))).toBe(true);
    expect(settingsMoving(answer(false))).toBe(false);
    const moving = deadlineWords({ configured: 60, pending: 60, effective: 120, rebuilding: true })!;
    expect(moving).toBe('Sessions Myco hasn’t reached yet still wait 120 minutes. Myco is moving them to 60; new sessions and the ones it has reached already use 60.');
    expect(deadlineWords({ configured: 60, pending: null, effective: 60, rebuilding: false })).toBeNull();
    expect(deadlineWords(undefined)).toBeNull();
  });

  it('shows a switch that waits for its provider, one that has not moved, and the sources it left out, each saying why', async () => {
    const waiting: EmbeddingSwitchStatus = { ...BUILDING, retryAt: NOW + 4 * 60_000, reason: 'The new model\'s provider had a problem (HTTP 503). Myco tries again shortly.',
      stalled: 'Rebuilding search has not moved for 42 minutes: the last embedding run failed (“the provider timed out”).',
      passedOver: { count: 23, sources: [{ projectId: P_X, projectName: 'Project X', type: 'session', title: 'A very long session', reason: 'the model refused its text with HTTP 400', anyModel: false }] } };
    server(base({ '/api/settings': () => Response.json({ ...leaves(), embedding: { ...HOSTED_CHOICES, switch: waiting } }) }));
    mount('/settings/models#embedding');
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
    mount('/settings/models#embedding');
    const panel = await waitFor(() => found('[data-embedding-switch="building"]'));
    expect(panel.textContent).toContain('Rebuilding search with bge-base-en-v1.5 (768 dimensions): 120 of 400 sources done (30%).');
    expect(panel.textContent).toContain('Search keeps using bge-m3 until every source is done, then moves to bge-base-en-v1.5 on its own.');
    expect(panel.textContent).toContain('Estimated cost: under $0.01');
    expect((screen.getByLabelText('Embedding model') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(panel as HTMLElement).getByRole('button', { name: 'Cancel the switch' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Search keeps using bge-m3, so what you can find doesn’t change. What was built for bge-base-en-v1.5 so far is thrown away');
    expect(sent).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel the switch' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'DELETE', path: `/api/embedding/switch/${BUILDING.id}` });
  });

  it('says a switch is still counting its sources rather than showing a partial total as final', async () => {
    const counting = { ...BUILDING, progress: 'building' as const, done: 40, total: 40,
      passedOver: { count: 2, sources: [{ projectId: P_X, projectName: 'Project X', type: 'plan', title: 'Release checklist', reason: 'its stored text is missing', anyModel: true }] } };
    server(base({ '/api/settings': () => Response.json({ ...leaves(), embedding: { ...HOSTED_CHOICES, switch: counting } }) }));
    mount('/settings/models#embedding');
    const panel = await waitFor(() => found('[data-embedding-switch="building"]'));
    expect(panel.textContent).toContain('Rebuilding search with bge-base-en-v1.5 (768 dimensions): 40 sources done so far, still counting the rest.');
    expect(panel.textContent).not.toContain('of 40');
    expect(panel.textContent).toContain('Still counting the sources search by meaning will pass over: 2 sources so far.');
    expect(panel.textContent).not.toContain('will have no search by meaning once search moves');
    // No meter offers a share of a partial total, visually or to assistive technology.
    expect(within(panel as HTMLElement).queryByRole('meter')).toBeNull();
    expect((panel as HTMLElement).querySelector('[aria-valuemax]')).toBeNull();
  });

  it('shows the exact share on a meter once a switch\'s sources are all counted', async () => {
    server(base({ '/api/settings': () => Response.json({ ...leaves(), embedding: { ...HOSTED_CHOICES, switch: { ...BUILDING, progress: 'ready', done: 40, total: 60 } } }) }));
    mount('/settings/models#embedding');
    const panel = await waitFor(() => found('[data-embedding-switch="building"]'));
    const meter = within(panel as HTMLElement).getByRole('meter');
    expect([meter.getAttribute('aria-valuenow'), meter.getAttribute('aria-valuemax'), meter.getAttribute('aria-valuetext')]).toEqual(['40', '60', '40 of 60']);
    expect(panel.textContent).toContain('40 of 60 sources done (66%)');
  });

  it('shows a paused switch with its reason and resumes it', async () => {
    const paused = { ...BUILDING, state: 'paused' as const, reason: 'The new model\'s provider turned down its key (HTTP 401). Check the key under Provider keys, then resume.' };
    const { sent } = server(base({
      '/api/settings': () => Response.json({ ...leaves(), embedding: { ...HOSTED_CHOICES, switch: paused } }),
      [`/api/embedding/switch/${BUILDING.id}/resume`]: () => Response.json({ applied: true, switch: BUILDING }),
    }));
    mount('/settings/models#embedding');
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
    mount('/settings/models#embedding');
    await waitFor(() => expect(statusOf('embedding.provider')).toContain('Reset the provider'));
    expect(screen.getByRole('button', { name: 'Clear the stored value for Embedding provider' })).toBeTruthy();
    expect(statusOf('embedding.provider')).toContain('Search uses Cloudflare Workers AI with bge-m3');
    expect(document.querySelector('[data-setting="embedding.provider"] [role="alert"]')).toBeNull();
  });

  it('shows a blank stored embedding model beside the running model and clears that leaf alone', async () => {
    const { sent } = server(base({
      '/api/settings': () => Response.json({ ...leaves(), leaves: leaves().leaves.map((row) => row.leaf === 'embedding.model'
        ? { ...row, configured: true, value: '', stored: '', storedApplies: false, state: 'invalid', reason: 'The blank stored model does not apply. Clear the stored value.' }
        : row) }),
    }));
    mount('/settings/models#embedding');
    await waitFor(() => expect(statusOf('embedding.model')).toContain('Search uses Cloudflare Workers AI with bge-m3'));
    expect(statusOf('embedding.model')).toContain('blank stored model');
    expect(document.querySelector('[data-setting="embedding.model"] [role="alert"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the stored value for Embedding model' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'DELETE', path: '/api/settings/embedding.model' });
  });

  it('sends the read revision, reloads after conflict and displays the current saved value', async () => {
    let current = 'first';
    let revision = '7';
    let reads = 0;
    const { sent } = server(base({
      '/api/settings': () => { reads++; return Response.json(leaves({ 'instructions.template': { value: current, revision } })); },
      '/api/settings/instructions.template': () => {
        current = 'saved by another editor'; revision = '8';
        return Response.json({ applied: false, reason: 'conflict', leaf: 'instructions.template', revision: 8 }, { status: 409 });
      },
    }));
    mount('/settings/advanced#cortex');
    const field = await screen.findByLabelText('Session-start instructions');
    const row = field.closest('[data-setting]') as HTMLElement;
    fireEvent.change(field, { target: { value: 'my stale draft' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.headers['if-match']).toBe('7');
    await waitFor(() => expect((screen.getByLabelText('Session-start instructions') as HTMLTextAreaElement).value).toBe(current));
    expect(reads).toBeGreaterThan(1);
    expect(statusOf('instructions.template')).toContain('Review the current value');
    expect(within(row).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });

  it('says the refusal in the person\'s words: a foreign leaf is named as not held, any other refusal carries its status, and a bad number never leaves', async () => {
    const { sent } = server(base({
      '/api/settings/cortex.spores.inject_on_prompt_submit': () => Response.json({ applied: false, reason: 'not_deployment_tier', leaf: 'cortex.spores.inject_on_prompt_submit' }, { status: 400 }),
      '/api/settings/agent.scheduled_tasks_active_window_days': () => Response.json({ error: 'nope' }, { status: 503 }),
    }));
    await mountAdvanced();
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
    mount('/settings/models#advanced');
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

  it('keeps the fallback agents in order, and saves a list only of agents a machine can run, each once', async () => {
    const held = { value: ['bogus', 'codex'] as unknown[] };
    const { sent } = server(base({
      '/api/settings': () => Response.json(leaves({ 'worker.harness_fallback': { value: held.value, updatedBy: ADA, updatedAt: NOW } })),
      '/api/settings/worker.harness_fallback': (init) => { held.value = JSON.parse(String(init!.body)).value; return Response.json({ applied: true }); },
    }));
    mount('/settings/models#agent-order');
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
    mount('/settings/advanced#code-map');
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
      'retention.raw_days': 30,
      'import.window_days': 45,
      'import.max_sessions_per_harness': 25,
      'agent.limits.task_runs_per_hour': 6,
    };
    const held = { ...CONFIGURED };
    const { sent } = server(base({
      '/api/settings': () => Response.json(leaves(Object.fromEntries(Object.entries(held).map(([leaf, value]) => [leaf, { value, updatedAt: NOW, updatedBy: ADA }])))),
      '/api/settings/retention.raw_days': (init) => {
        held['retention.raw_days'] = JSON.parse(String(init!.body)).value;
        return Response.json({ applied: true });
      },
    }));
    mount('/settings?tab=records');

    const window = await screen.findByLabelText('Keep raw transcripts in active storage for');
    expect((window as HTMLInputElement).value).toBe('30');
    fireEvent.change(window, { target: { value: '60' } });
    fireEvent.blur(window);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/settings/retention.raw_days', body: { value: 60 } });
    expect(Object.keys(sent[0]!.body as object)).toEqual(['value']);

    await waitFor(() => expect((screen.getByLabelText('Keep raw transcripts in active storage for') as HTMLInputElement).value).toBe('60'));
    for (const [groupLabel, label, leaf] of [
      ['What sessions receive', 'Session-start instructions', 'instructions.template'],
      ['Importing past sessions', 'Reach back at most', 'import.window_days'],
      ['Importing past sessions', 'At most, per agent', 'import.max_sessions_per_harness'],
      ['How much at once', 'Runs of one task per hour', 'agent.limits.task_runs_per_hour'],
    ] as const) {
      await group(groupLabel);
      const field = await screen.findByLabelText(label);
      expect({ leaf, value: (field as HTMLInputElement).value }).toEqual({ leaf, value: String(CONFIGURED[leaf]) });
    }
    await section('Models');
    expect((await screen.findByLabelText(/^Agent(?::|$)/)).textContent).toContain('Claude Code');
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
    mount('/settings/advanced');
    await group('What sessions receive');
    expect(screen.queryByRole('region', { name: 'Older settings' })).toBeNull();
  });

  it('takes which settings are retired from the server\'s answer, not from a list of its own', async () => {
    server(base({
      '/api/settings': () => Response.json(leaves({
        'cortex.digest.tier': { value: 8000, updatedBy: ADA, updatedAt: NOW, retired: true },
      })),
    }));
    mount('/settings/models');
    await screen.findByText('Answered by');
    expect(screen.queryByRole('region', { name: 'Older settings' })).toBeNull();
  });

  it('shows every switch at the value the server applies while nothing is stored', async () => {
    server(base({ '/api/settings': () => Response.json(leaves()) }));
    await mountAdvanced();
    for (const [label, on] of [
      ['Instructions at session start', true], ['Instructions when a subagent starts', true], ['Plan nudge on every prompt', true],
      ['Spores on every prompt', true],
    ] as const) {
      const toggle = await screen.findByRole('switch', { name: label });
      expect({ label, on: toggle.getAttribute('aria-checked') === 'true' }).toEqual({ label, on });
    }
    expect(screen.queryByRole('switch', { name: 'Update the map on its own' })).toBeNull();
    expect(statusOf('cortex.instructions.inject_on_session_start')).toBe('This setting is on (server default).');
  });

  it('says what the server said was wrong with a value it refused', async () => {
    server(base({ '/api/settings/cortex.spores.max_per_prompt': () => Response.json({ applied: false, reason: 'invalid_value', leaf: 'cortex.spores.max_per_prompt', detail: 'expected a whole number' }, { status: 400 }) }));
    mount('/settings/advanced#cortex');
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
    expect(oldTabTarget('secrets')).toBe('/settings/connections#credentials');
    expect(oldTabTarget('single-turn')).toBe('/settings/models#single-turn');
    expect(oldTabTarget('workers')).toBe('/settings/models#workers');
    expect(oldTabTarget('capabilities')).toBe('/settings/repositories#projects');
    expect(oldTabTarget('records')).toBe('/settings/advanced#records');
    expect(oldTabTarget('agent')).toBe('/settings/models');
    expect(oldTabTarget('backup')).toBe('/settings/advanced#backup');
    expect(oldTabTarget('maintenance')).toBe('/settings/advanced#maintenance');
    expect(oldTabTarget('cortex')).toBe('/settings/advanced#cortex');
    expect(oldTabTarget('scheduling')).toBe('/settings#scheduling');
    expect(oldTabTarget('embedding')).toBe('/settings/models#embedding');
    expect(oldTabTarget('nope')).toBe('/settings');
    for (const old of ['scheduling', 'limits', 'cortex', 'code-map', 'embedding', 'workers', 'backup', 'maintenance', 'records', 'import', 'advanced']) {
      expect({ old, group: LEAF_GROUPS.some((g) => g.id === old) }).toEqual({ old, group: true });
    }
  });

  it('lead every older address to the place that holds its content now, and show that content', async () => {
    const byId = (id: string) => () => found(`#${CSS.escape(id)}`);
    const addresses: Array<[old: string, now: string, content: () => HTMLElement | Promise<HTMLElement>]> = [
      ['/settings?tab=secrets', '/settings/connections#credentials', () => screen.findByRole('group', { name: 'Connections' })],
      ['/settings/capture?tab=secrets', '/settings/connections#credentials', () => screen.findByRole('group', { name: 'Connections' })],
      ['/settings/access#github-app', '/settings/repositories#github-app', byId('github-app')],
      ['/settings/connections#github-app', '/settings/repositories#github-app', byId('github-app')],
      ['/settings/access#telemetry', '/settings/connections#telemetry', byId('telemetry')],
      ['/settings#single-turn', '/settings/models#single-turn', byId('single-turn')],
      ['/settings/models#agent-order', '/settings/advanced#agent-order', () => screen.findByRole('list', { name: 'Then try, in order' })],
      ['/settings/models#models-advanced', '/settings/advanced#advanced-settings', () => screen.findByRole('group', { name: 'Advanced' })],
      ['/settings#cortex', '/settings/advanced#cortex', () => screen.findByRole('switch', { name: 'Spores on every prompt' })],
      ['/settings/capture#import', '/settings/advanced#import', () => screen.findByLabelText('Reach back at most')],
      ['/settings/backups', '/settings/advanced#backups', () => screen.findByText(/Back up every/)],
      ['/settings/access', '/settings/people', () => screen.findByRole('group', { name: 'Who can sign in?' })],
      ['/settings/access#projects', '/settings/repositories#projects', () => screen.findByRole('link', { name: 'Access keys' })],
      ['/settings?tab=capabilities', '/settings/repositories#projects', () => screen.findByRole('link', { name: 'Access keys' })],
      ['/people#ownership', '/settings/advanced#ownership', () => screen.findByRole('heading', { name: 'Server owner' })],
      ['/people#raw-claims', '/settings/advanced#raw-claims', () => found('[data-fold="owner-actions"] [aria-expanded="true"]')],
    ];
    for (const [old, now, content] of addresses) {
      server(base({ '/auth/me': () => Response.json(dashboardMe({ ...ME, owner: true })), '/api/ownership': () => Response.json({ ownerMemberId: ADA, revision: 'owner-r1', candidates: [], proposalMemberId: null }) }));
      mount(old);
      await waitFor(() => expect({ old, now: location() }).toEqual({ old, now }));
      expect({ old, content: await waitFor(content).then(() => true, () => false) }).toEqual({ old, content: true });
      cleanup();
    }
    server(base());
    mount('/settings/access#projects');
    expect((await screen.findByRole('link', { name: 'Access keys' })).getAttribute('href')).toBe(`/p/${P_X}/settings#access-keys`);
  });

  it('land on a list’s place once it has loaded, even when the list is empty, and lead a member who is not an admin there too', async () => {
    const proto = window.HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
    const original = proto.scrollIntoView;
    const scrolled: string[] = [];
    proto.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.id); };
    try {
      for (const [old, anchor] of [['/settings?tab=secrets', 'credentials'], ['/settings/access#telemetry', 'telemetry']]) {
        server(base({ '/api/secrets': () => Response.json(secrets(false)) }));
        mount(old!);
        await waitFor(() => expect(scrolled).toContain(anchor));
        expect(document.querySelector('[data-connection="key"], [data-connection="telemetry"]')).toBeNull();
        cleanup();
      }
      server(base({ '/auth/me': () => Response.json(dashboardMe({ ...ME, member: { ...ME.member, role: 'member' as const } })) }));
      mount('/settings?tab=secrets');
      await waitFor(() => expect(location()).toBe('/settings/connections#credentials'));
    } finally { proto.scrollIntoView = original; }
  });
});

describe('Models', () => {
  it('says what each quick-jobs answerer costs and needs, shows an address’s fields only for it, and returns to the included model by clearing them', async () => {
    let answeredBy = 'address';
    const address = { 'single_turn.base_url': { value: 'http://localhost:1234/v1' }, 'single_turn.model': { value: 'qwen3' } };
    const { sent } = server(base({
      '/api/settings': () => Response.json({ ...leaves(answeredBy === 'address' ? address : {}), quickJobs: { ...HOSTED_QUICK_JOBS, answeredBy } }),
      '/api/quick-jobs/address': () => { answeredBy = 'included'; return Response.json({ applied: true }); },
    }));
    mount('/settings/models');
    const help = () => document.querySelector('[data-quick-jobs-help]')?.textContent ?? '';
    await waitFor(() => expect(help()).toContain('It costs what that service charges'));
    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe('http://localhost:1234/v1');
    expect(screen.getByRole('button', { name: 'Add key' })).toBeTruthy();
    await pick('Answered by', 'Cloudflare (included)');
    await waitFor(() => expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual(['DELETE /api/quick-jobs/address']));
    expect(JSON.parse(sent[0]!.headers['if-match']!)).toEqual({ 'single_turn.base_url': 0, 'single_turn.model': 0 });
    await waitFor(() => expect(help()).toContain('Included with your Cloudflare account'));
    expect(screen.queryByLabelText('Address')).toBeNull();
    await pick('Answered by', 'My own model address');
    expect(await screen.findByLabelText('Address')).toBeTruthy();
    expect(statusOf('quick-jobs')).toBe('Cloudflare (included) still answers until the address and model are saved.');
    expect(sent).toHaveLength(1);
  });

  it('says with no agent chosen which agent each runner uses today, offers only agents runners report, and clears a choice back to no preference', async () => {
    let held: string | null = null;
    const { sent } = server(base({
      '/api/settings': () => Response.json(leaves(held === null ? {} : { 'worker.harness': { value: held } })),
      '/api/runners/agents': () => Response.json(payers([{ agent: 'claude-code', runners: [['rn_mini', 'homelab-mini', 'own']] }, { agent: 'codex', runners: [['rn_mini', 'homelab-mini', 'own']] }],
        [['rn_mini', 'homelab-mini', 'claude-code'], ['rn_win', 'CHRISTOPHER63F5', null]])),
      '/api/settings/worker.harness': (init) => { held = JSON.parse(String(init!.body)).value; return Response.json({ applied: true }); },
    }));
    mount('/settings/models');
    const note = () => document.querySelector('[data-agent-note]')?.textContent ?? '';
    await waitFor(() => expect(note()).toBe('No agent chosen: each runner uses the first agent it is signed in to. Today: homelab-mini uses Claude Code; CHRISTOPHER63F5 uses no agent it is signed in to.'));
    expect(screen.getByLabelText(/^Agent(?::|$)/).textContent).toContain('No preference');
    expect(document.querySelector('[data-setting="paid-by"]')?.textContent).toContain('For Claude Code, the agent your runners use today.');
    fireEvent.click(screen.getByLabelText(/^Agent(?::|$)/));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual(['No preference', 'Claude Code', 'Codex']);
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/settings/worker.harness', body: { value: 'codex' } });
    await waitFor(() => expect(note()).toContain('No other agent is tried.'));
    await pick('Agent', 'No preference');
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'PUT', path: '/api/settings/worker.harness', body: { value: null } });
  });

  it('sets who pays in one request for every runner offering the agent, refuses a stored key none is usable for and offers to add one, and checks whether a run could start', async () => {
    let usable = false;
    const { sent } = server(base({
      '/api/settings': () => Response.json(leaves({ 'worker.harness': { value: 'claude-code' } })),
      '/api/runners/agents': () => Response.json(payers([{ agent: 'claude-code', storedUsable: usable, runners: [['rn_win', 'CHRISTOPHER63F5', 'stored'], ['rn_mini', 'homelab-mini', 'own']] }])),
      '/api/runners/sign-in': () => Response.json({ error: 'credential_unavailable' }, { status: 409 }),
      '/api/runners/check': () => Response.json({ task: 'extract-curate', observedAt: NOW, reason: 'budget', takers: [{ agent: 'claude-code', runners: [{ id: 'rn_mini', name: 'homelab-mini' }] }] }),
    }));
    mount('/settings/models');
    const list = await screen.findByRole('list', { name: 'What each runner uses for Claude Code' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['CHRISTOPHER63F5: the stored key', 'homelab-mini: its own sign-in']);
    expect(screen.getByLabelText('Paid by').textContent).toContain('Differs by runner');
    await pick('Paid by', 'A stored key');
    expect((await screen.findByRole('alert')).textContent).toContain('No usable key is stored for Claude Code, so nothing was saved.');
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Replace the key' }));
    expect((await screen.findByRole('dialog')).textContent).toContain('Replace the Anthropic key');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    cleanup();
    usable = true;
    mount('/settings/models');
    await screen.findByRole('list', { name: 'What each runner uses for Claude Code' });
    await pick('Paid by', 'A stored key');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'POST', path: '/api/runners/sign-in', body: { agent: 'claude-code', choice: 'stored' } });
    expect((await screen.findByRole('alert')).textContent).toBe('Nothing was saved: no usable key is stored for Claude Code.');
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(statusOf('agent-work-check')).toContain('Not now: homelab-mini could take it with Claude Code, but today’s work budget is used up'));
    expect(sent).toHaveLength(1);
  });

  it('saves stored-first without a key and shows the runner’s fallback on Models and Connections', async () => {
    let choice = 'own';
    let ownReady = true;
    const { sent } = server(base({
      '/api/settings': () => Response.json(leaves(ownReady ? { 'worker.harness': { value: 'claude-code' } } : {})),
      '/api/runners/agents': () => Response.json({ today: [], agents: [{
        agent: 'claude-code', storedUsable: false, runners: [{ id: 'mini', name: 'Mini', choice }, { id: 'studio', name: 'Studio', choice }],
        ...(choice === 'own' ? {} : { storedFailure: 'out_of_credit', ...(ownReady ? { fallbacks: [
          { runnerId: 'mini', agent: 'claude-code', slot: 'anthropic', reason: 'out_of_credit', since: NOW },
          { runnerId: 'studio', agent: 'claude-code', slot: 'anthropic', reason: 'out_of_credit', since: NOW },
        ] } : { waiting: [{ runnerId: 'mini', agent: 'claude-code', slot: 'anthropic', failure: 'out_of_credit' }] }) }),
      }, {
        agent: 'codex', storedUsable: false, runners: [{ id: 'desk', name: 'Desk', choice: 'stored-first' }],
        fallbacks: [{ runnerId: 'desk', agent: 'codex', slot: 'codex', reason: 'out_of_credit', since: NOW }],
      }] }),
      '/api/runners/sign-in': () => { choice = 'stored-first'; return Response.json({ saved: true }); },
    }));
    const label = 'A stored key first, then the runner’s own sign-in';
    mount('/settings/models');
    await screen.findByRole('combobox', { name: /^Paid by/ });
    await pick('Paid by', label);
    await screen.findByRole('combobox', { name: `Paid by: ${label}` });
    expect(sent[0]).toMatchObject({ path: '/api/runners/sign-in', body: { agent: 'claude-code', choice: 'stored-first' } });
    const notice = await screen.findByRole('status', { name: 'Claude Code sign-in fallback' });
    expect(notice.textContent).toContain('Mini, Studio');
    expect(notice.textContent).toContain('Out of credit · using runners’ own sign-in');
    expect(notice.textContent).toContain('Work continues on the runner’s own sign-in');
    expect(screen.getByRole('status', { name: 'Codex sign-in fallback' }).textContent).toContain('Desk');
    expect(statusOf('paid-by')).toContain('Using runners’ own sign-in');
    cleanup();
    mount('/settings/connections');
    const key = within(await waitFor(() => connection('Anthropic key')));
    await key.findByText('Out of credit', { exact: true });
    await key.findByText(/Work continues on the runner’s own sign-in/);
    cleanup();
    ownReady = false;
    mount('/settings/models');
    await waitFor(() => expect(statusOf('paid-by')).toContain('Work that needs this key waits.'));
    expect(screen.queryByRole('status', { name: 'Claude Code sign-in fallback' })).toBeNull();
  });

  it('points to Advanced for model sizes and keeps search on Models', async () => {
    server(base());
    mount('/settings/models');
    expect(await screen.findByRole('group', { name: 'Search' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Advanced › Model sizes' }).getAttribute('href')).toBe('/settings/advanced#model-sizes');
    expect(document.querySelector('[data-fold]')).toBeNull();
  });
});

describe('Advanced', () => {
  it('folds every group with one line on what it holds and whether it was changed, and lists only the agents runners offer', async () => {
    server(base({ '/api/settings': () => Response.json(leaves({ 'agent.reasoning_map.codex.low': { value: 'luna', updatedBy: ADA, updatedAt: NOW }, 'backup.retention.keep_weekly': { value: 4, updatedBy: ADA, updatedAt: NOW } })) }));
    mount('/settings/advanced');
    await waitFor(() => {
      const states = Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-fold]')].map((fold) => [fold.dataset.fold, fold.querySelector('[data-fold-state]')?.textContent]));
      expect(states).toEqual({ 'model-sizes': 'Changed by Ada just now', pace: 'All default', 'sessions-given': 'All default', 'new-and-past': 'imported sessions get titles',
        kept: 'All default', backups: 'Automatic backups off · Changed by Ada just now', upkeep: 'All default', 'owner-actions': 'Rarely needed' });
    });
    expect(document.querySelector('[data-fold="backups"]')!.textContent).toContain('A scheduled backup pauses the dashboard while it runs');
    expect(document.querySelector('[data-fold="backups"]')!.textContent).toContain('Cloudflare can also put the database back to a recent point without one.');
    expect(document.querySelector('[data-fold="kept"]')!.textContent).toContain('Raw transcripts move to archive after 90 days.');
    expect(screen.queryByLabelText('Small jobs model')).toBeNull();
    cleanup();
    server(base({ '/api/runners/agents': () => Response.json(payers([{ agent: 'claude-code', runners: [['rn_mini', 'homelab-mini', 'own']] }])) }));
    mount('/settings/advanced#model-sizes');
    await waitFor(() => expect(document.getElementById('claude-profile')).not.toBeNull());
    expect([...document.querySelectorAll<HTMLElement>('section[id$="-profile"]')].map((section) => section.id)).toEqual(['claude-profile']);
    expect(screen.getByRole('group', { name: 'Size of each job' })).toBeTruthy();
  });
});

describe('Connections', () => {
  it('lists each stored key with what it is for, its kind and what uses it, replaces one without ever showing it, and removes one only once confirmed', async () => {
    const { sent } = server(base({
      '/api/runners/agents': () => Response.json(payers([{ agent: 'claude-code', storedUsable: true, runners: [['rn_mini', 'homelab-mini', 'stored']] }])),
      '/api/secrets/anthropic': (init) => (init?.method === 'DELETE' ? Response.json({ deleted: true }) : Response.json({ name: 'anthropic', configured: true, readable: true, maskedValue: 's…0', kind: 'api-key', updatedAt: NOW, updatedBy: ADA })),
    }));
    mount('/settings/connections');
    const key = await waitFor(() => { const row = connection('Anthropic key'); expect(row.textContent).toContain('Used by homelab-mini (Claude Code).'); return row; });
    expect(key.textContent).toContain('Claude Code and OpenCode use it for Myco’s work when you choose a stored key instead of each runner’s own sign-in.');
    expect(key.textContent).toContain('Subscription token: draws on that subscription.');
    expect(key.textContent).toContain('saved by Ada');
    expect(within(key).getByText('In use')).toBeTruthy();
    expect(screen.queryByText('Codex (OpenAI) key')).toBeNull();
    fireEvent.click(within(key).getByRole('button', { name: 'Replace' }));
    fireEvent.change(await screen.findByLabelText('Anthropic key'), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/secrets/anthropic', body: { value: SECRET } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const el of document.querySelectorAll('input, textarea')) expect((el as HTMLInputElement).value).not.toBe(SECRET);
    fireEvent.click(within(connection('Anthropic key')).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Work that needs this key waits until one is stored. A runner set to “A stored key first, then the runner’s own sign-in” carries on instead');
    expect(sent).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'DELETE', path: '/api/secrets/anthropic' });
  });

  it('adds a key by first asking what kind of connection, then whose key, and keeps the dialog open with a refusal', async () => {
    server(base({ '/api/secrets/codex': () => Response.json({ error: 'bad_request', reason: 'a key carries no line breaks' }, { status: 400 }) }));
    mount('/settings/connections');
    fireEvent.click(await screen.findByRole('button', { name: 'Add a connection' }));
    const kinds = await screen.findByRole('list', { name: 'Kinds of connection' });
    expect(within(kinds).getAllByRole('button')).toHaveLength(3);
    for (const name of [/^A model key/, /^A launcher that reports activity/, /^An agent that reads one project from outside/]) expect(within(kinds).getByRole('button', { name })).toBeTruthy();
    fireEvent.click(within(kinds).getByRole('button', { name: /^A model key/ }));
    expect(screen.queryByLabelText('Name it after the launcher')).toBeNull();
    await pick('Whose key', 'Codex (OpenAI)');
    fireEvent.change(await screen.findByLabelText('Codex (OpenAI) key'), { target: { value: 'x\ny' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The server could not accept that.');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows what a telemetry key reported and how a launcher uses it, shows a new key’s header once, and removes one only once confirmed', async () => {
    let revoked = false;
    const key = { id: 'tk_build', label: 'routr on mbp', lastUsedAt: NOW, revokedAt: null, usedSpans: 100, spanQuota: 100, dailySpans: 3, clockSkewMs: 120_000, quotaReached: true, cleanupDone: false, accepted: 113, rejected: 0 };
    const { sent } = server(base({
      '/api/telemetry/keys': (init) => (init?.method === 'POST'
        ? Response.json({ key: 'example-key', headers: 'Authorization=Bearer%20example-key', endpoint: 'https://myco.example' })
        : Response.json({ endpoint: 'https://myco.example', keys: [{ ...key, revokedAt: revoked ? NOW : null }] })),
      '/api/telemetry/keys/tk_build/revoke': () => { revoked = true; return Response.json({ revoked: true }); },
    }));
    mount('/settings/connections');
    const row = await waitFor(() => connection('routr on mbp'));
    expect(row.textContent).toContain('113 accepted, none rejected in the last day');
    expect(row.textContent).toContain('120 seconds');
    expect(within(row).getByText('Full')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'How a launcher uses this key' }));
    expect(row.querySelector('[data-telemetry-usage]')?.textContent).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=https://myco.example');
    fireEvent.click(screen.getByRole('button', { name: 'Add a connection' }));
    fireEvent.click(await screen.findByRole('button', { name: /^A launcher that reports activity/ }));
    fireEvent.change(screen.getByLabelText('Name it after the launcher'), { target: { value: 'My sender' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect((await screen.findByRole('dialog')).textContent).toContain('OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20example-key"');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(document.body.textContent).not.toContain('example-key'));
    fireEvent.click(within(connection('routr on mbp')).getByRole('button', { name: 'Remove' }));
    expect((await screen.findByRole('dialog')).textContent).toContain('what it already reported is removed');
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    await waitFor(() => expect(revoked).toBe(true));
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual(['POST /api/telemetry/keys', 'POST /api/telemetry/keys/tk_build/revoke']);
  });
});

describe('Title imported sessions', () => {
  it('says once that it is still counting while titling totals build', () => {
    const words = progressWords({ ...TITLING, building: true, owed: null, remaining: null } as never);
    expect(words.match(/Still counting which sessions wait for a title\./g)).toHaveLength(1);
  });

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
    mount('/settings/advanced#titling');
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
    mount('/settings/advanced#titling');
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
    mount('/settings/advanced#titling');
    expect(await screen.findByText('Couldn’t read where titling stands just now.')).toBeTruthy();
    fireEvent.click(within(document.querySelector('[data-setting="titling-backfill"]') as HTMLElement).getByRole('button', { name: 'Retry' }));
    const toggle = await screen.findByRole('switch', { name: 'Title imported sessions' });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    fireEvent.click(toggle);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The server refused (503).');
    expect(screen.getByRole('switch', { name: 'Title imported sessions' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Title imported sessions' }).getAttribute('aria-checked')).toBe('true'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(puts).toBe(2);
  });

  it('names a stale titling switch and holds Try again until the settings have been read again', async () => {
    let holding = false;
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    server(base({
      '/api/settings': async () => {
        if (holding) await held;
        return Response.json(leaves());
      },
      '/api/titling-backfill': (init) => init?.method === 'PUT'
        ? Response.json({ applied: false, reason: 'conflict', leaf: 'agent.tasks', actual: 2, expected: 1, next: 'read again' }, { status: 409 })
        : Response.json({ ...TITLING, backfillEnabled: false, enabled: false }),
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mount('/settings/advanced#titling', client);
    const toggle = await screen.findByRole('switch', { name: 'Title imported sessions' });
    await waitFor(() => expect(client.getQueryData(['settings'])).toBeDefined());
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    fireEvent.click(toggle);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This changed since the page read it.');
    const again = () => within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    await waitFor(() => expect(again().disabled).toBe(false));
    holding = true;
    void client.invalidateQueries({ queryKey: ['settings'] });
    await waitFor(() => expect(again().disabled).toBe(true));
    release();
    await waitFor(() => expect(again().disabled).toBe(false));
  });

  it('words titling in every state, and its schedule', () => {
    const base = { scheduledTasksEnabled: true, backfillEnabled: true, runsPerDay: 24, intervalSeconds: 900, runIn: ['active', 'idle'], overlap: 'queue' as const, enabled: true, building: false, remaining: 0, owed: 0, usedToday: 3, inFlight: 1, completedToday: 2, failedToday: 0, waiting: null };
    expect(progressWords(base)).toBe('No session that ended here is waiting for a title. No imported session is waiting for a title. Titles start while the server is in use or idle, at most once every 15 min. Today: 3 of 24 started, 1 in progress, 2 titled, 0 failed.');
    expect(progressWords({ ...base, owed: 4, remaining: 1, runsPerDay: null, runIn: ['idle'], intervalSeconds: 60 })).toBe('4 sessions that ended here are waiting for a title; they are titled on their own within the daily limit. 1 imported session is waiting for a title. Titles start while the server is idle, at most once every 1 min. Today: 3 started, 1 in progress, 2 titled, 0 failed.');
    expect(progressWords({ ...base, scheduledTasksEnabled: false, enabled: false, owed: 1 })).toBe('1 session that ended here is waiting for a title; they are titled on their own within the daily limit. No imported session is waiting for a title. Titling them is on, but runs only while Work on its own is on. Titles start while the server is in use or idle, at most once every 15 min. Today: 3 of 24 started, 1 in progress, 2 titled, 0 failed.');
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
    expect(waitingWords({ runsPerDay: 36, waiting: { reason: 'reserved', until: later } }, now)).toBe(`The rest of today’s limit of 36 is kept for sessions that ended, went quiet or went on today; older sessions can start at ${clock(later)} (in 3h).`);
    expect(waitingWords({ runsPerDay: 24, waiting: { reason: 'overlap', until: null } }, now)).toBe('Waiting for the title in progress to finish.');
    expect(waitingWords({ runsPerDay: 24, waiting: { reason: 'interval', until: now + 12 * 60_000 } }, now)).toBe(`The next titles can start at ${clock(now + 12 * 60_000)} (in 12m).`);
    expect(waitingWords({ runsPerDay: 24, waiting: { reason: 'interval', until: now - 1 } }, now)).toBe('The next titles can start soon.');
  });
});

describe('GitHub on Repositories', () => {
  it('carries the App setup as a live checklist with direct links, approves an installation, connects proposed repositories and says set up only once a Project reads one', async () => {
    let state: unknown = SETUP;
    const { sent } = server(base({ '/api/github-app': () => Response.json(state),
      '/api/github-app/installations': () => Response.json({ installations: [], accounts: [{ accountId: 9001, login: 'goondocks-co', type: 'Organization', approvedBy: ADA, approvedAt: NOW }], page: 1, more: false, app: { slug: 'myco-app', owner: APP_OWNER } }),
      '/api/github-app/accounts': () => Response.json({ account: {} }),
      '/api/github-app/accounts/9001': () => Response.json({ withdrawn: true }),
      '/api/github-app/suggestions': () => Response.json({ complete: true, withheld: [], suggestions: ['a', 'b'].map((name, index) => ({ projectId: `proj_${name}`, project: name, installationId: 41, repositoryId: index + 1, fullName: `goondocks-co/${name}`, defaultBranch: 'main' })) }),
      '/api/projects/proj_a/repository': () => Response.json({ repository: null, appConfigured: true }),
      '/api/projects/proj_b/repository': () => Response.json({ repository: null, appConfigured: true }) }));
    mount('/settings/repositories');
    await screen.findByText('This server’s App is Myco (app), owned by goondocks-co (an organization).');
    await screen.findByText('In GitHub, open goondocks-co’s organization page → Settings, then Developer settings → GitHub Apps.');
    expect(within(document.querySelector('[data-app-identity]') as HTMLElement).getByRole('link', { name: 'Open the App’s settings' }).getAttribute('href')).toBe('https://github.com/organizations/goondocks-co/settings/apps/myco-app');
    const key = document.querySelector('[data-step="key"]') as HTMLElement;
    expect(within(key).getByText('Import the App’s private key.')).toBeTruthy();
    expect(within(key).getByText(`myco server github-app --target cloudflare --url ${window.location.origin} --private-key-file <downloaded.pem>`)).toBeTruthy();
    expect(within(document.querySelector('[data-step="installed"]') as HTMLElement).getByRole('link', { name: 'Install the App in GitHub' }).getAttribute('href')).toBe('https://github.com/apps/myco-app/installations/new');
    expect(screen.getByText(/^Repository access is not set up yet: 4 of 6 steps remain\. Next: Import the App’s private key\.$/)).toBeTruthy();
    expect(screen.getByText(/confirm access/)).toBeTruthy();
    state = { ...KEYED, installations: { list: [INSTALLED], more: false } };
    fireEvent.click(within(connection('GitHub')).getByRole('button', { name: 'Test' }));
    const installed = await screen.findByText('Installed by an account this server has not approved: goondocks-co (an organization)');
    fireEvent.click(within(installed.parentElement as HTMLElement).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(sent.filter((request) => request.method === 'POST').map(({ path, body }) => ({ path, body }))).toEqual([{ path: '/api/github-app/accounts', body: { installationId: 41 } }]));
    state = { ...KEYED, installations: { list: [{ ...INSTALLED, approved: true }], more: false } };
    fireEvent.click(within(connection('GitHub')).getByRole('button', { name: 'Test' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Find repositories for my Projects' }));
    await screen.findByText('a: goondocks-co/a, branch main');
    fireEvent.click(screen.getByRole('button', { name: 'Connect all 2' }));
    await waitFor(() => expect(sent.filter((request) => request.method === 'PUT').map(({ path, body }) => ({ path, body }))).toEqual(['a', 'b'].map((name, index) => ({
      path: `/api/projects/proj_${name}/repository`, body: { installationId: 41, repositoryId: index + 1, branch: 'main', revision: null } }))));
    state = { ...KEYED, installations: { list: [{ ...INSTALLED, approved: true }], more: false }, connectedProjects: 2, repository: { project: 'a', fullName: 'goondocks-co/a' } };
    fireEvent.click(within(connection('GitHub')).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(within(connection('GitHub')).getByText('Working')).toBeTruthy());
    expect(connection('GitHub').textContent).toContain('Myco reads your repositories, read-only, through its own GitHub App: Myco (app), owned by goondocks-co (an organization).');
    expect(connection('GitHub').textContent).toContain('Installed on goondocks-co.');
    expect(document.querySelector('[data-setup-headline]')).toBeNull();
    expect(document.querySelector('[data-step]')).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Install on another account' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Accounts it can read for' }));
    const approved = (await screen.findByText('goondocks-co (an organization)', { selector: '[data-approved-accounts] span' })).parentElement as HTMLElement;
    fireEvent.click(within(approved).getByRole('button', { name: 'Remove approval' }));
    await waitFor(() => expect(sent.filter((request) => request.method === 'DELETE').map(({ method, path }) => ({ method, path }))).toEqual([{ method: 'DELETE', path: '/api/github-app/accounts/9001' }]));
  });

  it('keeps approving and installing open after the first account, withholds proposals from an incomplete search, and reads the facts again on every opening', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let state: unknown = { ...KEYED, installations: { list: [{ ...INSTALLED, approved: true }, { installationId: 42, account: { login: 'second-org', type: 'Organization' }, approved: false, suspended: false, permissionsAccepted: false }], more: false } };
    let reads = 0;
    server(base({ '/api/github-app': () => { reads += 1; return Response.json(state); },
      '/api/github-app/installations': () => Response.json({ installations: [], accounts: [], page: 1, more: false, app: { slug: 'myco-app', owner: APP_OWNER } }),
      '/api/github-app/suggestions': () => Response.json({ complete: false, suggestions: [], withheld: [{ projectId: 'proj_a', project: 'a' }] }) }));
    mount('/settings/repositories', client);
    const approved = await waitFor(() => { const step = document.querySelector('[data-step="approved"]') as HTMLElement; expect(step.dataset.state).toBe('done'); return step; });
    expect(within(approved).getByText('Installed by an account this server has not approved: second-org (an organization); has not accepted the new permissions')).toBeTruthy();
    expect(within(approved).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(document.querySelector('[data-step="installed"]') as HTMLElement).getByRole('link', { name: 'Install on another account' }).getAttribute('href')).toBe('https://github.com/apps/myco-app/installations/new');
    fireEvent.click(screen.getByRole('button', { name: 'Find repositories for my Projects' }));
    await screen.findByText('a: Not every repository could be checked; connect this one by hand from its Settings → Repository.');
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    cleanup();
    state = { ...SETUP, key: { state: 'unavailable', reason: 'GitHub refused App verification (HTTP 401).' } };
    mount('/settings/repositories', client);
    await screen.findByText('GitHub did not accept the imported key: GitHub refused App verification (HTTP 401).');
    expect(reads).toBe(2);
  });

});

describe('Repositories', () => {
  it('lists every live project, most active first, with its repository from every page or Connect, five first, then all', async () => {
    const names = ['myco', 'atlas', 'notes', 'ledger', 'infra', 'blog', 'docs'];
    const projects = names.map((name, index) => ({ projectId: `proj_${name}`, name, createdAt: 0, sessionCount: 0, lastActivityAt: NOW - index * 60_000, archivedAt: null, archivedBy: null }));
    server(base({
      '/api/projects': () => Response.json({ projects: [...projects, { ...projects[0]!, projectId: 'proj_gone', name: 'gone', archivedAt: 1, archivedBy: ADA }] }),
      '/api/repositories': (_init, url) => Response.json(url!.searchParams.get('cursor') === 'proj_myco'
        ? { repositories: [{ projectId: 'proj_notes', url: 'https://github.com/goondocks-co/notes.git', branch: 'main' }, { projectId: 'proj_docs', url: 'https://github.com/goondocks-co/docs', branch: 'trunk' }], cursor: null }
        : { repositories: [{ projectId: 'proj_myco', url: 'https://github.com/goondocks-co/myco.git', branch: 'main' }], cursor: 'proj_myco' }),
    }));
    mount('/settings/repositories');
    const list = await screen.findByRole('group', { name: 'Projects and their repositories' });
    await waitFor(() => expect(list.querySelectorAll('[data-project-repository]')).toHaveLength(5));
    const row = (name: string) => within(list).getByText(name, { exact: true }).closest('[data-project-repository]') as HTMLElement;
    expect([...list.querySelectorAll('[data-project-repository]')].map((element) => element.querySelector('span')?.textContent)).toEqual(names.slice(0, 5));
    expect(row('myco').textContent).toContain('goondocks-co/myco · main');
    expect(row('notes').textContent).toContain('goondocks-co/notes · main');
    expect(row('atlas').textContent).toContain('Not connected');
    expect(within(row('atlas')).getByRole('link', { name: 'Connect' }).getAttribute('href')).toBe('/p/proj_atlas/settings#repository');
    expect(within(row('atlas')).getByRole('link', { name: 'Access keys' }).getAttribute('href')).toBe('/p/proj_atlas/settings#access-keys');
    fireEvent.click(within(list).getByRole('button', { name: 'Show all' }));
    expect(list.querySelectorAll('[data-project-repository]')).toHaveLength(7);
    expect(row('docs').textContent).toContain('goondocks-co/docs · trunk');
    expect(within(list).queryByText('gone')).toBeNull();
    cleanup();
    server(base({ '/api/repositories': () => new Response(null, { status: 500 }) }));
    mount('/settings/repositories');
    await screen.findByRole('alert');
    expect(document.querySelector('[data-project-repository]')).toBeNull();
    cleanup();
    server(base());
    mount('/settings/connections');
    await waitFor(() => expect(within(connection('GitHub')).getByRole('link', { name: 'Repositories' }).getAttribute('href')).toBe('/settings/repositories#github-app'));
    expect(document.querySelector('[data-step]')).toBeNull();
  });
});

const QUEUE = { observedAt: NOW, count: 0, oldestAt: null, reasons: [], nativeNeedsRunner: false };
const runner = (over: Record<string, unknown>) => ({ machineId: null, state: 'enabled', display: 'Online', connected: true, busy: null, lastCompleted: null, lastFailed: null, lastAttempted: null,
  offers: [{ id: 'claude-code', authenticated: true }], credentialChoices: {}, storedKeyFailures: [], ...over });
const STATUS = (budget: Record<string, unknown>) => Response.json({ workers: { available: true, fleet: [] }, budget: { active: true, reason: null, dailyUsd: 30, automaticUsd: 4, manualUsd: 0.56, liveUsd: 0, unconfirmed: null, heldHeads: [], pricedExposure: null, state: 'ready', ...budget } });

describe('Myco’s work', () => {
  it('switches work on its own and back to its default, sets the budget, says who changed each and what counts against it, and lists every runner with its latest run and how it pays', async () => {
    const run = (task: string, ago: number) => ({ runId: `run_${task}`, task, at: NOW - ago, projectId: P_X, projectName: 'Project X', status: 'x' });
    const { sent } = server(base({
      '/api/settings': () => Response.json(leaves({ 'agent.scheduled_tasks_enabled': { value: true, updatedBy: ADA, updatedAt: NOW }, 'agent.budget.daily_usd': { value: 30, updatedBy: ADA, updatedAt: NOW } })),
      '/api/settings/agent.scheduled_tasks_enabled': () => Response.json({ applied: true }),
      '/api/settings/agent.budget.daily_usd': () => Response.json({ applied: true }),
      '/api/status': () => STATUS({}),
      '/api/runners/agents': () => Response.json(payers([{ agent: 'claude-code', runners: [['rn_mini', 'homelab-mini', 'own'], ['rn_win', 'win-box', 'stored']] }], [['rn_mini', 'homelab-mini', 'claude-code'], ['rn_win', 'win-box', 'claude-code']])),
      '/api/runners': (_init, url) => Response.json(url!.searchParams.get('cursor') === null
        ? { observedAt: NOW, legacyWorkers: [], queue: QUEUE, storedCredentials: { 'claude-code': false }, totals: { active: 2 }, cursor: 'page_2',
          runners: [runner({ id: 'rn_mini', name: 'homelab-mini', lastCompleted: run('canopy-map', 13 * 3_600_000) })] }
        : { observedAt: NOW, legacyWorkers: [], queue: QUEUE, cursor: null, runners: [runner({ id: 'rn_win', name: 'win-box', display: 'Not ready',
          lastFailed: run('extract-curate', 2 * 3_600_000), lastAttempted: run('extract-curate', 2 * 3_600_000), credentialChoices: { 'claude-code': 'stored' }, connected: false,
          storedKeyFailures: [{ agent: 'claude-code', slot: 'anthropic', failure: 'out_of_credit' }] })] }),
    }));
    mount('/settings');
    const own = await screen.findByRole('switch', { name: 'Work on its own' });
    expect(own.getAttribute('aria-checked')).toBe('true');
    expect(statusOf('agent.scheduled_tasks_enabled')).toMatch(/^Changed by you on /);
    await waitFor(() => expect(statusOf('agent.budget.daily_usd')).toContain('$4.56 counts against it now: what was spent in the last 24 hours, plus estimates for runs still going or not yet priced'));
    const budget = screen.getByLabelText('Daily budget in dollars') as HTMLInputElement;
    expect(budget.value).toBe('30');
    fireEvent.change(budget, { target: { value: '25' } });
    fireEvent.blur(budget);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/settings/agent.budget.daily_usd', body: { value: 25 } });
    fireEvent.click(screen.getByRole('button', { name: 'Use default ($20)' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: 'DELETE', path: '/api/settings/agent.budget.daily_usd' });
    fireEvent.click(screen.getByRole('button', { name: 'Use the default (off)' }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toMatchObject({ method: 'DELETE', path: '/api/settings/agent.scheduled_tasks_enabled', headers: { 'if-match': '0' } });
    fireEvent.click(own);
    await waitFor(() => expect(sent).toHaveLength(4));
    expect(sent[3]).toMatchObject({ method: 'PUT', path: '/api/settings/agent.scheduled_tasks_enabled', body: { value: false } });
    const mini = await waitFor(() => found('[data-runner-row="rn_mini"]'));
    await waitFor(() => expect(mini.textContent).toContain('Set to pay for Claude Code with its own sign-in, and can use it now'));
    expect(mini.textContent).toContain('Last ran a code map update 13 h ago');
    expect(within(mini).getByRole('link', { name: 'Manage' }).getAttribute('href')).toBe('/settings/people/runners/rn_mini');
    expect(document.querySelector('[data-runner-row="rn_win"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Show more/ }));
    const win = await waitFor(() => found('[data-runner-row="rn_win"]'));
    expect(win.textContent).toContain('Last run, learning, failed 2 h ago');
    expect(win.textContent).toContain('Set to pay for Claude Code with the stored key, but couldn’t use it when last seen.');
    expect(win.textContent).toContain('ran out of API credit');
    expect(win.textContent).toContain('Not ready');
    fireEvent.click(screen.getByRole('button', { name: 'Add a runner' }));
    expect(found('[data-add-runner]').textContent).toContain(`myco runner register ${window.location.origin}`);
  });

  it('says a runner set to the stored key first is on its own sign-in while that key is out of credit', async () => {
    server(base({
      '/api/status': () => STATUS({}),
      '/api/runners/agents': () => Response.json(payers([{ agent: 'claude-code', runners: [['rn_mini', 'homelab-mini', 'stored-first']] }], [['rn_mini', 'homelab-mini', 'claude-code'], ['rn_win', 'win-box', null]])),
      '/api/runners': () => Response.json({ observedAt: NOW, legacyWorkers: [], queue: QUEUE, cursor: null, runners: [runner({ id: 'rn_mini', name: 'homelab-mini',
        credentialChoices: { 'claude-code': 'stored-first' }, fallbackNotices: [{ agent: 'claude-code', slot: 'anthropic', reason: 'out_of_credit', since: NOW }] }), runner({ id: 'rn_win', name: 'win-box' })] }),
    }));
    mount('/settings');
    const mini = await waitFor(() => found('[data-runner-row="rn_mini"]'));
    await waitFor(() => expect(mini.textContent).toContain('Set to pay for Claude Code with the stored key first, then its own sign-in. The Anthropic key ran out of API credit. Work continues on the runner’s own sign-in'));
    expect(found('[data-runner-row="rn_win"]').textContent).toContain('No agent on it can do this work now');
  });

  it('saves a typed budget against the revision it was read at, so a newer change by someone else refuses it', async () => {
    let revision = '5';
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { sent } = server(base({
      '/api/settings': () => Response.json(leaves({ 'agent.budget.daily_usd': { value: revision === '5' ? 30 : 40, revision, updatedBy: ADA, updatedAt: NOW } })),
      '/api/settings/agent.budget.daily_usd': () => Response.json({ applied: false, reason: 'conflict', leaf: 'agent.budget.daily_usd', revision: 6 }, { status: 409 }),
      '/api/status': () => STATUS({}),
    }));
    mount('/settings', client);
    const budget = await screen.findByLabelText('Daily budget in dollars') as HTMLInputElement;
    fireEvent.change(budget, { target: { value: '25' } });
    revision = '6';
    await client.refetchQueries({ queryKey: ['settings'] });
    fireEvent.blur(budget);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.headers['if-match']).toBe('5');
    await waitFor(() => expect(statusOf('agent.budget.daily_usd')).toContain('Review the current value'));
    await waitFor(() => expect((screen.getByLabelText('Daily budget in dollars') as HTMLInputElement).value).toBe('40'));
  });

  it('says what it could not read rather than guessing: an unknown switch, a failed status read and a failed runner read', async () => {
    server(base({
      '/api/settings': () => Response.json({ ...leaves(), leaves: leaves().leaves.map((row) => row.leaf === 'agent.scheduled_tasks_enabled' ? { ...row, state: 'unknown', effective: null } : row) }),
      '/api/status': () => new Response(null, { status: 500 }),
      '/api/runners': () => new Response(null, { status: 500 }),
    }));
    mount('/settings');
    await waitFor(() => expect(statusOf('agent.scheduled_tasks_enabled')).toContain('Not known right now'));
    expect(screen.queryByRole('switch', { name: 'Work on its own' })).toBeNull();
    await waitFor(() => expect(statusOf('agent.budget.daily_usd')).toContain('Couldn’t read what counts against the budget'));
    const runners = screen.getByRole('group', { name: 'Where the work runs' });
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(runners.textContent).not.toContain('No machine runs Myco’s work yet');
    cleanup();
    server(base({ '/api/status': () => STATUS({ state: 'building', automaticUsd: null }) }));
    mount('/settings');
    await waitFor(() => expect(statusOf('agent.budget.daily_usd')).toContain('Still measuring what counts against the budget'));
  });
});

describe('People and machines', () => {
  it('lists who can sign in, never Myco, and every machine page by page, each leading to its page, with the former ones folded', async () => {
    const machine = { machineId: 'm_ada', name: 'ada-mbp', live: true, canStop: true, stopReason: null, member: { id: ADA, label: 'Ada', revoked: false }, claimedAt: 0, credentialCount: 1,
      liveCredentialCount: 1, bytesWritten: 0, firstSeenAt: 0, standing: 'allowed', stoppedBy: null, offers: null, lastContactAt: NOW, lastRunAt: null, lastCaptureAt: NOW - 60_000,
      capture: [{ agent: 'claude-code', lastEventAt: NOW - 60_000, projectId: P_X }, { agent: 'codex', lastEventAt: NOW - 120_000, projectId: P_X }] };
    server(base({
      '/api/members': () => Response.json({ members: MEMBERS.members.map((member) => ({ ...member, effectiveRole: member.id === ADA ? 'owner' : member.role, liveMachines: member.id === ADA ? 1 : 0 })) }),
      '/api/machines': (_init, url) => Response.json(url!.searchParams.get('cursor') === null
        ? { machines: [{ ...machine, machineId: 'm_lin', name: 'lin-pc', member: { id: LIN, label: null, revoked: false } }], cursor: 'page_2' }
        : { machines: [machine, { ...machine, machineId: 'm_old', name: 'old-mac', liveCredentialCount: 0, standing: 'expired' }], cursor: null }),
      '/api/runners': () => Response.json({ observedAt: NOW, legacyWorkers: [], queue: QUEUE, cursor: null, runners: [runner({ id: 'rn_ada', name: 'ada-mbp', machineId: 'm_ada', display: 'Offline', connected: false }), runner({ id: 'rn_mini', name: 'homelab-mini' })] }),
    }));
    mount('/settings/people');
    const people = await screen.findByRole('group', { name: 'Who can sign in?' });
    await waitFor(() => expect(people.querySelectorAll('[data-list-row="person"]')).toHaveLength(2));
    expect(people.textContent).toContain('Ada · Owner · you');
    expect(people.textContent).toContain('Signs in with GitHub · 1 machine');
    expect(people.textContent).toContain('No GitHub account connected yet');
    expect(people.textContent).not.toContain('harness');
    const machines = screen.getByRole('group', { name: 'Machines' });
    await waitFor(() => expect(machines.textContent).toContain('lin-pc'));
    expect(machines.textContent).toContain('Runners that are machines of their own are listed once every machine is read.');
    fireEvent.click(within(machines).getByRole('button', { name: /^Show more/ }));
    const row = await waitFor(() => found('#machine-m_ada'));
    expect(row.textContent).toContain('Captures Claude Code, Codex · runs Myco’s work as ada-mbp');
    expect(row.textContent).toContain('Capturing');
    expect(within(row).getByRole('link', { name: 'Manage' }).getAttribute('href')).toBe('/settings/people/machines/m_ada');
    const mini = await waitFor(() => found('#runner-rn_mini'));
    expect(within(mini).getByRole('link', { name: 'Manage' }).getAttribute('href')).toBe('/settings/people/runners/rn_mini');
    expect(machines.querySelector('#runner-rn_ada')).toBeNull();
    expect(within(machines).getByRole('button', { name: 'Former machines (1)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Advanced › Owner actions' }).getAttribute('href')).toBe('/settings/advanced#owner-actions');
    fireEvent.click(screen.getByRole('button', { name: 'Invite a teammate' }));
    expect(await screen.findByRole('button', { name: 'Create invitation link' })).toBeTruthy();
    expect(rawIdsIn(document.body, ['[data-testid="location"]'])).toEqual([]);
  });

  it('says a failed machine read failed, and that whether a machine runs Myco’s work is unknown when the runners could not be read', async () => {
    server(base({ '/api/machines': () => new Response(null, { status: 500 }) }));
    mount('/settings/people');
    const machines = await screen.findByRole('group', { name: 'Machines' });
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(machines.textContent).not.toContain('No machine can write here now');
    cleanup();
    server(base({
      '/api/machines': () => Response.json({ machines: [{ machineId: 'm_ada', name: 'ada-mbp', live: true, canStop: true, stopReason: null, member: { id: ADA, label: 'Ada', revoked: false }, claimedAt: 0, credentialCount: 1,
        liveCredentialCount: 1, bytesWritten: 0, firstSeenAt: 0, standing: 'allowed', stoppedBy: null, offers: null, lastContactAt: null, lastRunAt: null, lastCaptureAt: null, capture: [] }], cursor: null }),
      '/api/runners': () => new Response(null, { status: 500 }),
    }));
    mount('/settings/people');
    const row = await waitFor(() => found('[data-list-row="machine"]'));
    await waitFor(() => expect(row.textContent).toContain('whether it runs Myco’s work is unknown'));
    expect(row.textContent).toContain('Has not captured an agent lately');
  });
});

it('shows retired task preferences as metadata outside the task-overrides editor', async () => {
  const historic = { 'title-summary': { provider: 'anthropic', reasoningLevel: 'low' }, 'container-smoke': { model: 'haiku' } };
  server(base({ '/api/settings': () => Response.json(leaves({ 'agent.tasks': { value: historic,
    editableValue: { 'title-summary': { reasoningLevel: 'low' } },
    retiredValue: { 'title-summary': { provider: 'anthropic' }, 'container-smoke': { model: 'haiku' } } } })) }));
  mount('/settings/models#advanced');
  const editor = await screen.findByRole('textbox', { name: 'Task overrides' });
  expect((editor as HTMLTextAreaElement).value).not.toContain('provider');
  expect((editor as HTMLTextAreaElement).value).not.toContain('container-smoke');
  const taskRow = editor.closest('[data-setting]') as HTMLElement;
  expect(taskRow.querySelector('pre') === null).toBe(true);
  fireEvent.click(within(taskRow).getByRole('button', { name: 'Stored value' }));
  expect(taskRow.querySelector('pre')?.textContent).toContain('container-smoke');
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
    mount('/settings/advanced#model-sizes');
    const claude = within(await group('Claude Code model sizes'));
    expect(claude.getAllByText(/^Models listed by your machines/)).toHaveLength(1);
    expect(document.querySelector('[data-model-listing="claude-code"]')?.textContent).toContain('Models listed by your machines 1 h ago, each with its own sign-in to Claude Code.');
    expect(statusOf(leaf)).toBe('Myco uses haiku (server default).');
    fireEvent.click(claude.getByLabelText('Small jobs model'));
    expect(await optionWords()).toEqual(['haiku: newest Haiku (now Haiku 4.5)', 'sonnet: newest Sonnet (now Sonnet 5.5)', 'Opus 4.8 (claude-opus-4-8)']);
    fireEvent.click(await screen.findByRole('option', { name: 'sonnet: newest Sonnet (now Sonnet 5.5)' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: `/api/settings/${leaf}`, body: { value: 'sonnet' } });
  });

  it('says whose login the list came from where runs sign in with the server login instead', async () => {
    const credential = 'agent.harnesses.codex.credential';
    server(base({ '/api/settings': withModels([CODEX], {}, (row) => (row.leaf === credential ? { ...row, effective: 'deployment', effectiveValue: 'deployment', source: 'default' } : row)) }));
    mount('/settings/advanced#model-sizes');
    await group('Codex model sizes');
    expect(document.querySelector('[data-model-listing="codex"]')?.textContent)
      .toBe('Models listed by your machines 1 h ago, each with its own sign-in to Codex. Legacy workers use the server’s stored key, which may offer different models. Registered runners use their own choices, set on Models or on each runner’s machine page.');
  });

  it('keeps a stored model no machine listed, and says so in plain words', async () => {
    const leaf = 'agent.reasoning_map.claude-code.high';
    server(base({ '/api/settings': withModels([CLAUDE], { [leaf]: { value: 'claude-opus-4-1', updatedBy: ADA, updatedAt: NOW } }) }));
    mount('/settings/advanced#model-sizes');
    await group('Claude Code model sizes');
    expect(statusOf(leaf)).toContain('claude-opus-4-1 is not among the models your machines listed for Claude Code.');
    fireEvent.click(within(await group('Claude Code model sizes')).getByLabelText('Large jobs model'));
    expect((await optionWords())[0]).toBe('claude-opus-4-1 (not listed)');
  });

  it('names a stored model\'s successor where the agent names one, and switches to it', async () => {
    const leaf = 'agent.reasoning_map.codex.high';
    const { sent } = server(base({
      '/api/settings': withModels([CODEX], { [leaf]: { value: 'gpt-5.5', updatedBy: ADA, updatedAt: NOW } }),
      [`/api/settings/${leaf}`]: () => Response.json({ applied: true }),
    }));
    mount('/settings/advanced#model-sizes');
    const codex = within(await group('Codex model sizes'));
    expect(statusOf(leaf)).toContain('Codex names GPT-6-Sol as the successor to GPT-5.5.');
    fireEvent.click(codex.getByRole('button', { name: 'Use GPT-6-Sol' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', path: `/api/settings/${leaf}`, body: { value: 'gpt-6-sol' } });
  });

  it('narrows a list to one provider by its name, and keeps the stored model shown whichever provider is chosen', async () => {
    const leaf = 'agent.reasoning_map.opencode.default';
    server(base({ '/api/settings': withModels([openCode(['openai/gpt-6', 'opencode/big-pickle', ...OPENROUTER_LATEST])], { [leaf]: { value: 'openai/gpt-6', updatedBy: ADA, updatedAt: NOW } }) }));
    mount('/settings/advanced#model-sizes');
    const opencode = within(await group('OpenCode model sizes'));
    fireEvent.click(opencode.getByLabelText(/^Medium jobs model provider(?::|$)/));
    expect(await optionWords()).toEqual(['All providers', 'OpenAI', 'OpenCode Zen', 'OpenRouter']);
    fireEvent.click(await screen.findByRole('option', { name: 'OpenRouter' }));
    await waitFor(() => expect(screen.queryByRole('option')).toBeNull());
    expect(opencode.getByLabelText('Medium jobs model').textContent).toContain('openai/gpt-6');
    fireEvent.click(opencode.getByLabelText('Medium jobs model'));
    expect(await optionWords()).toEqual(['openai/gpt-6', ...OPENROUTER_LATEST]);
  });

  it('marks the model the agent runs when none is named, and says what an unset tier means', async () => {
    server(base({ '/api/settings': withModels([CODEX]) }));
    mount('/settings/advanced#model-sizes');
    await group('Codex model sizes');
    expect(statusOf('agent.reasoning_map.codex.low')).toContain('Myco uses none');
    fireEvent.click(within(await group('Codex model sizes')).getByLabelText('Small jobs model'));
    expect((await optionWords())[0]).toBe('GPT-6.1-Sol (gpt-6.1-sol), Codex’s default');
  });

  it('says what an unset tier means where the model is typed, too', async () => {
    server(base({ '/api/settings': withModels([]) }));
    mount('/settings/advanced#model-sizes');
    await group('Codex model sizes');
    expect(statusOf('agent.reasoning_map.codex.low')).toContain('Myco uses none');
  });

  it('offers a preset in plain words where a machine lists all its models, and applies it tier by tier through the same write', async () => {
    const tiers = ['low', 'default', 'high'].map((tier) => `agent.reasoning_map.opencode.${tier}`);
    const { sent } = server(base({
      '/api/settings': withModels([openCode(['openai/gpt-6', ...OPENROUTER_LATEST])]),
      ...Object.fromEntries(tiers.map((leaf) => [`/api/settings/${leaf}`, () => Response.json({ applied: true })])),
    }));
    mount('/settings/advanced#model-sizes');
    const opencode = within(await group('OpenCode model sizes'));
    expect(opencode.getByText('Newest Claude through OpenRouter')).toBeTruthy();
    expect(opencode.getByText('Haiku, Sonnet and Opus through OpenRouter, always the newest version. Offered because your machines’ OpenCode lists these models from OpenRouter.')).toBeTruthy();
    fireEvent.click(opencode.getByRole('button', { name: 'Model IDs' }));
    expect(opencode.getByText(`Large: ${OPENROUTER_LATEST[2]}`)).toBeTruthy();
    fireEvent.click(opencode.getByRole('button', { name: 'Use these models' }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((s) => ({ method: s.method, path: s.path, body: s.body }))).toEqual(tiers.map((leaf, i) => ({ method: 'PUT', path: `/api/settings/${leaf}`, body: { value: OPENROUTER_LATEST[i] } })));
    expect(await opencode.findByText('Every size now uses these models.')).toBeTruthy();
  });

  it('offers no preset where no machine lists its models', async () => {
    server(base({ '/api/settings': withModels([openCode(['openai/gpt-6', 'github-copilot/claude-opus-5.5'])]) }));
    mount('/settings/advanced#model-sizes');
    expect(within(await group('OpenCode model sizes')).queryByRole('button', { name: 'Use these models' })).toBeNull();
  });

  it('types a model where no machine has listed the agent\'s models, or where the person asks to', async () => {
    server(base({ '/api/settings': withModels([CLAUDE]) }));
    mount('/settings/advanced#model-sizes');
    const codex = within(await group('Codex model sizes'));
    expect(codex.getByLabelText('Small jobs model').tagName).toBe('INPUT');
    expect(document.querySelector('[data-model-listing="codex"]')).toBeNull();
    const claude = within(await group('Claude Code model sizes'));
    expect(claude.getByLabelText('Small jobs model').tagName).toBe('BUTTON');
    fireEvent.click(claude.getAllByRole('button', { name: 'Type a model name' })[0]!);
    expect(claude.getByLabelText('Small jobs model').tagName).toBe('INPUT');
  });
});


it('repairs non-applying task entries separately from clearing all overrides', async () => {
  const historic = { 'cortex-instructions': { schedule: { maxRunsPerDay: 3 } }, 'title-summary': { schedule: { enabled: true, intervalSeconds: 900, maxRunsPerDay: 24 } } };
  let repaired = false;
  const { sent } = server(base({
    '/api/settings': () => Response.json({ ...leaves(), leaves: leaves().leaves.map((row) => row.leaf === 'agent.tasks' ? {
      ...row, configured: true, stored: repaired ? { 'title-summary': historic['title-summary'] } : historic,
      editableValue: repaired ? { 'title-summary': historic['title-summary'] } : historic,
      effective: { 'title-summary': historic['title-summary'] }, repair: repaired ? undefined : 'clean-document', storedApplies: repaired,
      reason: repaired ? null : 'The cortex-instructions task no longer exists.',
    } : row) }),
    '/api/settings/agent.tasks/repair': () => { repaired = true; return Response.json({ applied: true }); },
  }));
  mount('/settings/models#advanced');
  const editor = await screen.findByRole('textbox', { name: 'Task overrides' });
  const row = within(editor.closest('[data-setting]') as HTMLElement);
  expect((editor.closest('[data-setting]') as HTMLElement).querySelector('pre') === null).toBe(true);
  expect(row.getByText('Clearing resets every task override, including imported-session titling.')).toBeTruthy();
  fireEvent.click(row.getByRole('button', { name: 'Effective value' }));
  const effectiveDisplay = (editor.closest('[data-setting]') as HTMLElement).querySelector('pre')!;
  expect(effectiveDisplay.textContent).toContain('title-summary');
  expect(effectiveDisplay.textContent).toContain('"enabled": true');
  expect(effectiveDisplay.textContent).not.toContain('cortex-instructions');
  fireEvent.click(row.getByRole('button', { name: 'Stored value' }));
  expect((editor.closest('[data-setting]') as HTMLElement).textContent).toContain('cortex-instructions');
  fireEvent.click(row.getByRole('button', { name: 'Remove entries that no longer apply' }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({ method: 'POST', path: '/api/settings/agent.tasks/repair', body: {} });
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).not.toContain('cortex-instructions'));
  expect((editor as HTMLTextAreaElement).value).toContain('"enabled": true');
  expect(row.getByRole('button', { name: 'Clear the stored value for Task overrides' })).toBeTruthy();
});

it('keeps blank-input placeholders short and the reason in the status sentence', async () => {
  const leaf = 'agent.limits.concurrent_runs';
  const reason = 'No limit applies.';
  server(base({ '/api/settings': () => Response.json({ ...leaves(), leaves: leaves().leaves.map((row) => row.leaf === leaf ? { ...row, effective: null, reason } : row) }) }));
  mount('/settings/advanced#limits');
  await waitFor(() => expect(statusOf(leaf)).toContain(reason));
  expect((screen.getByRole('spinbutton', { name: 'Tasks at once' }) as HTMLInputElement).placeholder).toBe('No limit');
  expect(statusOf(leaf)).toContain('Myco uses no limit (not set).');
  expect(screen.queryByRole('heading', { name: 'Container smoke test' })).toBeNull();
});


it('shows the server task concurrency default and saves an explicit unlimited override separately from reset', async () => {
  const leaf = 'agent.limits.task_concurrent_runs';
  let value: number | null | undefined;
  const { sent } = server(base({
    '/api/settings': () => Response.json(leaves({ [leaf]: { value } })),
    ['/api/settings/' + leaf]: (init) => {
      value = init?.method === 'DELETE' ? undefined : JSON.parse(String(init?.body)).value;
      return Response.json({ applied: true });
    },
  }));
  mount('/settings/advanced#limits');
  const input = await screen.findByRole('spinbutton', { name: 'Runs of one task at once' });
  expect((input as HTMLInputElement).placeholder).toBe('2');
  expect(statusOf(leaf)).toContain('Myco uses 2 (server default).');
  expect(screen.getByText('Across all projects, this many runs of the same task can work at once. Further runs wait until one finishes.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Set no limit for Runs of one task at once' }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/settings/' + leaf, body: { value: null } });
  await waitFor(() => expect(statusOf(leaf)).toContain('Myco uses no limit (stored value).'));
  fireEvent.click(screen.getByRole('button', { name: 'Clear the stored value for Runs of one task at once' }));
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toMatchObject({ method: 'DELETE', path: '/api/settings/' + leaf });
  await waitFor(() => expect(statusOf(leaf)).toContain('Myco uses 2 (server default).'));
});
