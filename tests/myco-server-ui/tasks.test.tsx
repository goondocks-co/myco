import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { TaskTiers } from '../../packages/myco-server/ui/src/features/admin/settings/TaskTiers';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import type { TaskDescription, TaskStartPreview } from '../../packages/myco-server/ui/src/features/tasks/wire';
import { TASK_DESCRIPTIONS } from './task-fixture';
import { ADMIN, MEMBER, P, PROJECTS } from '../helpers/work-fixture';

const originalFetch = globalThis.fetch;
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); globalThis.fetch = originalFetch; forgetProject(); });

const description = (index: number): TaskDescription => ({
  task: `task-${index}`, name: `Task from registry ${index}`, description: `Description from registry ${index}`,
  triggers: [`Trigger from registry ${index}`], tools: [`Tool from registry ${index}`], done: [`Done from registry ${index}`],
  budget: { timeoutSeconds: 420 + index, readWindow: { sporePage: 10, sporePreviewChars: 20, sporeBodyChars: 30, sporeFullReads: 40, sessionPage: 50, sessionTitleChars: 60, sessionSummaryChars: 70, sessionLabelChars: 80, promptPage: 90 } },
  tier: 'high', profiles: [{ harness: 'codex', model: `model-from-registry-${index}`, effort: 'high', note: null }], profileNote: null, availabilityNote: null, startable: false, capability: null,
  promptTemplate: `Exact ask ${index}\n\n  Preserve indentation.\n`, standingRules: `Exact rules ${index}\n\nDo the declared work.\n`,
  templateVariants: [{ name: `Variant ${index}`, prompt: `Exact variant ${index}\n` }],
});
const TASKS = Array.from({ length: 6 }, (_, index) => description(index));

const PREVIEW = (url: URL): TaskStartPreview => ({
  task: url.searchParams.get('task')!, projectId: url.searchParams.get('project')!,
  executions: [{ harness: 'codex', tier: 'high', model: 'gpt-6', effort: 'high', workers: [] }], heldBy: null, workers: 2,
  readiness: { condition: 'has-unprocessed-prompts', met: false }, live: false, capability: null, allowance: null,
});

function server(tasks = TASKS, options: { member?: boolean; projects?: typeof PROJECTS; failProjects?: boolean; sent?: Array<{ path: string; body: unknown }>; week?: Promise<void>; preview?: Promise<void> } = {}) {
  const asked: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://s');
    asked.push(url);
    if ((init?.method ?? 'GET') !== 'GET') options.sent?.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.pathname === '/api/tasks/start') { await options.preview; return Response.json(PREVIEW(url)); }
    if (url.pathname === '/api/harness/dispatch') return Response.json({ runId: 'run_hand0000001', projectId: JSON.parse(String(init!.body)).projectId, queued: true });
    if (url.pathname === '/api/work') { await options.week; } if (url.pathname === '/api/work') return Response.json({ outcomes: [], runs: [], upkeep: { lastSuccessAt: null, unrecovered: null }, totals: null });
    if (url.pathname.endsWith('/capabilities')) return Response.json({ capabilities: { vault_evolution: true, canopy: true, cortex: true } });
    if (url.pathname === '/auth/me') return Response.json(options.member ? MEMBER : ADMIN);
    if (url.pathname === '/api/projects') return options.failProjects ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(options.projects ?? PROJECTS);
    if (url.pathname === '/api/settings/agent.tasks') { tasks[0] = { ...tasks[0]!, tier: 'low', profiles: [{ harness: 'codex', model: 'changed-model', effort: 'low', note: null }] }; return Response.json({ applied: true }); }
    if (url.pathname === '/api/tasks') return Response.json({ tasks });
    if (url.pathname === `/api/projects/${P}/runs`) return Response.json({ rows: [], cursor: null });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return asked;
}
function mount(path: string, settings = false) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App />{settings && <TaskTiers tiers={[{ task: 'title-summary', tier: 'high', source: 'task' }]} />}</MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

describe('the Tasks view reads the registry', () => {
  it('uses one visible project for a member reading all task descriptions', async () => {
    const projects = { ...PROJECTS, projects: Array.from({ length: 70 }, (_, index) => ({ ...PROJECTS.projects[0]!, projectId: `project-${index}` })) };
    const asked = server(TASKS, { member: true, projects });
    mount('/work/tasks');
    await screen.findByRole('heading', { name: TASKS[0]!.name });
    expect(asked.find((url) => url.pathname === '/api/tasks')?.searchParams.getAll('project')).toEqual(['project-0']);
  });

  it('asks a member without projects to pick a project instead of loading forever', async () => {
    const asked = server(TASKS, { member: true, projects: { ...PROJECTS, projects: [] } });
    mount('/work/tasks');
    await screen.findByText('Pick a project to see its tasks');
    expect(asked.some((url) => url.pathname === '/api/tasks')).toBe(false);
    expect(screen.queryByText('Loading tasks')).toBeNull();
  });

  it('surfaces the project read failure when a member reads all tasks', async () => {
    const asked = server(TASKS, { member: true, failProjects: true });
    mount('/work/tasks');
    await screen.findAllByRole('alert');
    expect(asked.some((url) => url.pathname === '/api/tasks')).toBe(false);
    expect(screen.queryByText('Loading tasks')).toBeNull();
  });

  it('renders every returned task and every displayed fact from its registry row', async () => {
    const asked = server();
    mount(`/p/${P}/work/tasks`);
    await screen.findByRole('heading', { level: 1, name: 'Tasks' });
    await screen.findByRole('heading', { name: TASKS[0]!.name });
    expect(document.querySelectorAll('article[data-task]')).toHaveLength(TASKS.length);
    for (const task of TASKS) {
      const card = document.getElementById(task.task)!;
      for (const text of [task.name, task.description, ...task.triggers, ...task.tools, ...task.done, task.profiles[0]!.model!]) expect(card.textContent).toContain(text);
      expect(card.textContent).toContain(String(task.budget!.timeoutSeconds));
    }
    expect(asked.find((url) => url.pathname === '/api/tasks')?.searchParams.get('project')).toBe(P);
  });

  it('discloses the ask, standing rules and variants without changing a byte', async () => {
    server();
    mount(`/p/${P}/work/tasks`);
    await screen.findByRole('heading', { name: TASKS[0]!.name });
    const task = TASKS[0]!;
    const card = document.getElementById(task.task)!;
    expect(card.querySelector('[data-task-exact]')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Exact rules and prompt template' }));
    expect(Array.from(card.querySelectorAll('[data-task-exact]')).map((node) => node.textContent)).toEqual([task.promptTemplate, task.standingRules, task.templateVariants[0]!.prompt]);
  });

  it('reads recent runs using the exact registry task and project', async () => {
    const asked = server();
    mount(`/p/${P}/work/tasks`);
    await screen.findByRole('heading', { name: TASKS[0]!.name });
    fireEvent.click(within(document.getElementById(TASKS[0]!.task)!).getByRole('link', { name: 'Recent runs →' }));
    await screen.findByText('This task has no recorded runs in this project.');
    expect(asked.find((url) => url.pathname === `/api/projects/${P}/runs`)?.searchParams.get('task')).toBe(TASKS[0]!.task);
  });

  it('changing a task tier through Settings refreshes its current model', async () => {
    const tasks = TASKS.map((row) => ({ ...row }));
    tasks[0] = { ...tasks[0]!, task: 'title-summary' };
    server(tasks);
    mount(`/p/${P}/work/tasks`, true);
    await screen.findByText(/model-from-registry-0/);
    window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
    fireEvent.click(await screen.findByLabelText('Titling tier'));
    fireEvent.click(await screen.findByRole('option', { name: 'Low' }));
    await waitFor(() => expect(screen.getByText(/changed-model/).textContent).toContain('low tier'));
    expect(screen.queryByText(/model-from-registry-0/)).toBeNull();
  });

  it('shows each possible agent profile with its own model and effort', async () => {
    const task = {
      ...description(0), tier: 'default',
      profiles: [
        { harness: 'claude-code', model: 'Sonnet', effort: 'medium', note: null },
        { harness: 'codex', model: 'gpt-6', effort: 'high', note: null },
        { harness: 'cursor', model: null, effort: null, note: 'A model choice is unavailable for Cursor.' },
      ],
      profileNote: 'Which agent runs it depends on what is signed in on your machines.',
    };
    server([task]);
    mount(`/p/${P}/work/tasks`);
    const card = await screen.findByRole('heading', { name: task.name }).then((node) => node.closest('article')!);
    expect(card.textContent).toContain('Sonnet');
    expect(card.textContent).toContain('default tier');
    expect(card.textContent).toContain('Claude Code: Sonnet, medium effort');
    expect(card.textContent).toContain('Codex: gpt-6, high effort');
    expect(card.textContent).toContain('A model choice is unavailable for Cursor.');
    expect(card.textContent).toContain(task.profileNote);
    expect(Array.from(card.querySelectorAll('[data-task-profile]')).map((line) => line.textContent)).toEqual([
      'default tier · Claude Code: Sonnet, medium effort',
      'default tier · Codex: gpt-6, high effort',
      'default tier · Cursor',
    ]);
  });

  it('folds only long tool lists on phones', async () => {
    const short = description(0);
    const long = { ...description(1), tools: ['One', 'Two', 'Three', 'Four', 'Five'] };
    server([short, long]);
    mount(`/p/${P}/work/tasks`);
    const shortCard = await screen.findByRole('heading', { name: short.name }).then((node) => node.closest('article')!);
    const longCard = await screen.findByRole('heading', { name: long.name }).then((node) => node.closest('article')!);
    expect(within(shortCard).queryByRole('button', { name: 'What it may use' })).toBeNull();
    const disclosure = within(longCard).getByRole('button', { name: 'What it may use' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(longCard.textContent).toContain('Five');
  });

  it('shows a runtime task without invented tools or budget and surfaces project availability', async () => {
    const task = {
      ...description(0), tools: [], budget: null, tier: null,
      profiles: [], profileNote: 'Runs without a model.', availabilityNote: 'Switched off for this project',
    };
    server([task]);
    mount(`/p/${P}/work/tasks`);
    const card = await screen.findByRole('heading', { name: task.name }).then((node) => node.closest('article')!);
    expect(within(card).queryByRole('region', { name: 'What it may use' })).toBeNull();
    expect(card.textContent).toContain('Runs without a model.');
    expect(card.textContent).toContain('Switched off for this project');
    expect(card.textContent).not.toContain('Up to');
    expect(within(card).queryByRole('button', { name: 'Reading limits' })).toBeNull();
  });
});

describe('starting a task from the Tasks view', () => {
  const startable = TASK_DESCRIPTIONS.filter((task) => task.startable);

  it('offers Run now on every task a person may start by hand, and on no other', async () => {
    expect(startable.map((task) => task.task).sort()).toEqual(['canopy-map', 'extract-curate', 'vault-seed']);
    for (const path of [`/p/${P}/work/tasks`, '/work/tasks']) for (const member of [false, true]) {
      server(TASK_DESCRIPTIONS, { member });
      mount(path);
      await screen.findByRole('heading', { name: TASK_DESCRIPTIONS[0]!.name });
      for (const task of TASK_DESCRIPTIONS) {
        const card = document.getElementById(task.task)!;
        expect({ path, member, task: task.task, run: within(card).queryByRole('button', { name: `Run now: ${task.name}` }) !== null }).toEqual({ path, member, task: task.task, run: task.startable });
      }
      cleanup();
      client.clear();
    }
  });

  it('confirms in the project with the agent and model the server resolves, then links the started run to its panel', async () => {
    const sent: Array<{ path: string; body: unknown }> = [];
    const asked = server(TASK_DESCRIPTIONS, { sent });
    mount(`/p/${P}/work/tasks`);
    const learning = TASK_DESCRIPTIONS.find((task) => task.task === 'extract-curate')!;
    fireEvent.click(await screen.findByRole('button', { name: `Run now: ${learning.name}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Learn from new sessions now?' });
    expect(dialog.querySelector('[data-run-task-project]')).toBeNull();
    await waitFor(() => expect(dialog.querySelector('[data-run-model]')!.textContent).toBe('Codex with gpt-6 at high effort, its high tier'));
    expect(dialog.querySelector('[data-readiness="unmet"]')!.textContent).toBe('There are no new sessions to learn from, so it will likely find nothing new to keep.');
    expect(asked.find((url) => url.pathname === '/api/tasks/start')!.searchParams.toString()).toBe(new URLSearchParams({ project: P, task: 'extract-curate' }).toString());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Learn now' }));
    await waitFor(() => expect(sent).toEqual([{ path: '/api/harness/dispatch', body: { projectId: P, task: 'extract-curate' } }]));
    const started = await waitFor(() => { const line = document.querySelector('[data-started]'); if (line === null) throw new Error('not yet'); return line as HTMLElement; });
    expect(started.textContent).toBe('Learning is queued. Waiting for a machine to pick it up.Open the run →');
    expect(within(started).getByRole('link', { name: 'Open the run →' }).getAttribute('href')).toBe(`/p/${P}/work/runs/run_hand0000001`);
  });

  it('starts nothing, and says no spend, until it has read where the run would go and what this week spent', async () => {
    let releaseWeek: () => void = () => undefined;
    let releasePreview: () => void = () => undefined;
    const sent: Array<{ path: string; body: unknown }> = [];
    server(TASK_DESCRIPTIONS, { sent, week: new Promise((resolve) => { releaseWeek = resolve; }), preview: new Promise((resolve) => { releasePreview = resolve; }) });
    mount(`/p/${P}/work/tasks`);
    const learning = TASK_DESCRIPTIONS.find((task) => task.task === 'extract-curate')!;
    fireEvent.click(await screen.findByRole('button', { name: `Run now: ${learning.name}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Learn from new sessions now?' });
    const confirm = within(dialog).getByRole('button', { name: 'Learn now' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(dialog.querySelector('[data-spend]')).toBeNull();
    expect(dialog.textContent).not.toContain('finished this week');
    releasePreview();
    await waitFor(() => expect(dialog.querySelector('[data-run-model]')).not.toBeNull());
    // Where it would run is read, but not yet what this week spent: still nothing to start, and no word on how long runs took.
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(dialog.textContent).not.toContain('Recent ones took');
    expect(dialog.querySelector('[data-spend]')).toBeNull();
    fireEvent.click(confirm);
    releaseWeek();
    await waitFor(() => expect(dialog.querySelector('[data-spend]')!.textContent).toContain('This spends model tokens.'));
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false));
    expect(sent).toEqual([]);
  });

  it('asks which project first when the view shows every project', async () => {
    const sent: Array<{ path: string; body: unknown }> = [];
    const asked = server(TASK_DESCRIPTIONS, { sent });
    mount('/work/tasks');
    const map = TASK_DESCRIPTIONS.find((task) => task.task === 'canopy-map')!;
    fireEvent.click(await screen.findByRole('button', { name: `Run now: ${map.name}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Update the code map now?' });
    expect(dialog.querySelector('[data-run-task-project]')!.textContent).toContain('Which project?');
    expect(within(dialog).getByRole('button', { name: 'Update the code map' }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Project: Choose a project' }), { key: 'Enter' });
    const list = await screen.findByRole('menu', { name: /^Project: / });
    fireEvent.click(within(list).getAllByRole('menuitemradio').find((item) => item.textContent!.startsWith(PROJECTS.projects[0]!.name))!);
    await waitFor(() => expect(asked.some((url) => url.pathname === '/api/tasks/start' && url.searchParams.get('project') === PROJECTS.projects[0]!.projectId)).toBe(true));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Update the code map' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update the code map' }));
    await waitFor(() => expect(sent).toEqual([{ path: '/api/harness/dispatch', body: { projectId: PROJECTS.projects[0]!.projectId, task: 'canopy-map' } }]));
  });
});
