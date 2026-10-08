/**
 * A run's "What it did": Myco's calls and the worker's steps in one list, the files it read, the agent's account
 * beside them with its checks, how much of the evidence is known, and each attempt of a reclaimed run.
 *
 * The code-map fixture is shaped like the owner's example that started #1592: a map update that read no sessions,
 * called Myco four times with one failure it corrected, and whose panel said nothing of the files it read.
 */
import { dashboardMe } from '../helpers/dashboard-permissions';
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import {
  attemptActivity, attemptAt, auditChecks, compareCommand, comparePath, coverageOf, coverageWords, filesRead, mycoUnnamed, summaryWords, type Coverage,
} from '../../packages/myco-server/ui/src/features/work/activity';
import { commandShape } from '@goondocks/myco-shared/command-shape';
import type { RunAttempt, RunAudit, RunCall, RunStep } from '../../packages/myco-server/ui/src/features/work/wire';
import { ADMIN, MEMBERS, MINUTE, NOW, P, PROJECTS, runDetail, TASK_RUNS, WEEK_WORK } from '../helpers/work-fixture';
import { TASK_DESCRIPTIONS } from './task-fixture';
import { MECHANISM_WORDS } from '../helpers/reader-vocabulary';
import { rawIdsIn } from '../helpers/raw-ids';

const RUN = 'run_c19f7a0e55';
const mapRun = TASK_RUNS['canopy-map']![1]!;
const T0 = NOW - 30 * MINUTE;

const originalFetch = globalThis.fetch;
let client: QueryClient;
beforeEach(() => { setSystemTime(new Date(NOW)); });
afterEach(() => {
  cleanup();
  client?.clear();
  globalThis.fetch = originalFetch;
  setSystemTime();
  forgetProject();
});

type Endpoint = (url: URL) => Response;

function serve(detail: unknown, extra: Record<string, Endpoint> = {}): URL[] {
  const asked: URL[] = [];
  const routes: Record<string, Endpoint> = {
    '/auth/me': () => Response.json(dashboardMe(ADMIN)),
    '/api/projects': () => Response.json(PROJECTS),
    '/api/members': () => Response.json(MEMBERS),
    '/api/attention': () => Response.json({ items: [], unavailable: [] }),
    '/api/tasks': () => Response.json({ tasks: TASK_DESCRIPTIONS }),
    '/api/tasks/names': () => Response.json({ tasks: TASK_DESCRIPTIONS.map(({ task, name }) => ({ task, name })) }),
    '/api/work': () => Response.json(WEEK_WORK),
    [`/api/projects/${P}/runs`]: () => Response.json({ rows: [], cursor: null }),
    [`/api/projects/${P}/capabilities`]: () => Response.json({ capabilities: { vault_evolution: true, canopy: true, cortex: true } }),
    [`/api/projects/${P}/runs/${RUN}`]: () => Response.json(detail),
    ...extra,
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    asked.push(url);
    return routes[url.pathname]?.(url) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return asked;
}

async function open(detail: unknown, extra: Record<string, Endpoint> = {}): Promise<{ panel: HTMLElement; asked: URL[] }> {
  const asked = serve(detail, extra);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[`/p/${P}/work/runs/${RUN}`]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
  const panel = await screen.findByTestId('run-panel');
  await within(panel).findByRole('heading', { level: 2 });
  return { panel, asked };
}

let seq = 0;
const step = (over: Partial<RunStep> & Pick<RunStep, 'kind' | 'tool'>): RunStep => {
  const at = T0 + (seq + 1) * 1_000;
  return { seq: seq++, callId: `toolu_${seq}`, target: null, outcome: 'ok', exitCode: null, startedAt: at, endedAt: at + 200, ...over };
};
const call = (id: number, tool: string, op: string, at: number, failure?: string): RunCall => ({
  id, tool, op, recordedAt: at, durationMs: 20, status: failure === undefined ? 'success' : 'failed',
  ...(failure === undefined ? {} : { failure: { code: 'tool_failure', message: failure } }),
});
const attempt = (attemptId: string, claimedAt: number, steps: RunStep[] | null, over: Partial<NonNullable<RunAttempt['steps']>> = {}, executor: RunAttempt['executor'] = { kind: 'member', memberId: 'mem_1' }): RunAttempt => ({
  attemptId, claimedAt, executor,
  steps: steps === null ? null : { total: steps.length, received: steps.length, overflow: 0, unrecognized: { total: 0, shapes: {} }, ...over },
});
const audit = (over: Partial<RunAudit> = {}): RunAudit => ({
  steps: ['Read the map', 'Read the changed files', 'Saved the map'], examined: [], commands: [], failures: [], reasoning: 'The map matched the source.', omitted: 0, ...over,
});

/** The owner's example: a code map update that read files, searched, ran a command and corrected one failed map write, reading no sessions. */
function codeMapRun(account: RunAudit | null = audit({
  examined: ['packages/myco/src/runner/loop.ts', 'packages/myco-shared/src'],
  commands: ['git log --oneline'],
  failures: [{ what: 'The first map write was refused', recovery: 'Shortened the entry and saved again' }],
})) {
  seq = 0;
  const steps = [
    step({ kind: 'myco', tool: 'mcp__myco__myco_run_map', target: 'get' }),
    step({ kind: 'read', tool: 'Read', target: '/work/checkout/packages/myco/src/runner/loop.ts' }),
    step({ kind: 'read', tool: 'Read', target: '/work/checkout/packages/myco-shared/src/command-shape.ts' }),
    step({ kind: 'search', tool: 'Grep', target: '/work/checkout/packages' }),
    step({ kind: 'command', tool: 'Bash', target: 'git log --oneline' }),
    step({ kind: 'myco', tool: 'mcp__myco__myco_run_map', target: 'write', outcome: 'error' }),
    step({ kind: 'myco', tool: 'mcp__myco__myco_run_map', target: 'write' }),
    step({ kind: 'myco', tool: 'mcp__myco__myco_run', target: 'report' }),
  ];
  const calls = [
    call(1, 'myco_run_map', 'get', T0 + 1_100),
    call(2, 'myco_run_map', 'write', T0 + 6_100, 'Map text must be a bounded nonempty line.'),
    call(3, 'myco_run_map', 'write', T0 + 7_100),
    call(4, 'myco_run', 'report', T0 + 8_100),
  ];
  const only = attempt('att-latest', T0, steps);
  return runDetail(mapRun, {
    run: { task: 'canopy-map', result: 'produced' },
    read: { sessions: [], total: 0, recorded: true },
    source: { branch: 'main', commit: 'b'.repeat(40) },
    toolCalls: calls,
    attempts: [only], attemptCount: 1, steps: { attemptId: only.attemptId, rows: steps, cursor: null },
    reports: [{ action: 'report', summary: 'Updated the code map.', details: null, audit: account, createdAt: T0 + 8_100 }],
  });
}

const complete = (steps: RunStep[]): Coverage => coverageOf(attempt('a', T0, steps), steps.length, true);

describe('the code map run from the owner’s example', () => {
  it('lists the files it read, the search, the command and the corrected failure, though it read no sessions', async () => {
    const { panel } = await open(codeMapRun());
    const did = within(panel).getByRole('region', { name: 'What it did' });
    const rows = within(did).getAllByRole('listitem');
    expect(rows).toHaveLength(8);
    expect(did.textContent).toContain('Read /work/checkout/packages/myco/src/runner/loop.ts');
    expect(did.textContent).toContain('Searched /work/checkout/packages');
    expect(did.textContent).toContain('Ran git log --oneline');
    expect(rows[5]!.textContent).toContain('Map text must be a bounded nonempty line.');
    expect(rows[5]!.textContent).toContain('Failed');
    expect(rows[5]!.textContent).toContain('a later call to the same operation succeeded');
    expect(rows[5]!.textContent).not.toContain('tried again');
    expect(rows[6]!.textContent).toContain('Succeeded');
    expect(rows.filter((row) => row.getAttribute('data-activity-seen') === 'both')).toHaveLength(4);
    expect(did.querySelector('[data-coverage="complete"]')!.textContent).toContain('Every step the worker saw is listed.');
    const files = within(panel).getByRole('region', { name: 'Files it read' });
    expect(files.textContent).toContain('/work/checkout/packages/myco/src/runner/loop.ts');
    expect(files.textContent).toContain('/work/checkout/packages/myco-shared/src/command-shape.ts');
    expect(files.textContent).not.toContain('/work/checkout/packages\n');
    expect(within(panel).queryByRole('region', { name: 'Sessions it read' })).toBeNull();
    expect(panel.querySelector('[data-run-summary]')!.textContent).toBe('Read 2 files, searched once, ran 1 command and saved the code map; 1 step failed.');
    // Every row is shown, so the list carries no "Showing 8 of 8".
    expect(did.textContent).not.toContain('Showing');
    expect(did.textContent).toContain('8 steps');
    for (const row of rows) expect(row.textContent).not.toMatch(MECHANISM_WORDS);
    expect(rawIdsIn(panel)).toEqual([]);
    // The tool and the call id sit in the row's folded details.
    expect(rows[4]!.textContent).not.toContain('Bash');
    fireEvent.click(within(rows[4]!).getByRole('button', { name: 'Technical details' }));
    expect(rows[4]!.querySelector('[data-facts]')!.textContent).toContain('Bash');
    expect(rows[4]!.querySelector('[data-facts]')!.textContent).toContain('toolu_5');
  });

  it('shows the agent’s account in plain words, and checks it clean when the steps match it', async () => {
    const { panel } = await open(codeMapRun());
    const report = within(panel).getByRole('region', { name: 'The agent’s report' });
    const account = report.querySelector('[data-run-account]')!;
    expect(account.textContent).toContain('Read the changed files');
    expect(account.textContent).toContain('git log --oneline');
    expect(account.textContent).toContain('Recovered: Shortened the entry and saved again');
    expect(account.textContent).toContain('The map matched the source.');
    const checks = within(report).getByRole('region', { name: 'Its account against what was seen' });
    expect(checks.getAttribute('data-audit-checks')).toBe('clear');
    expect(checks.querySelectorAll('[data-audit-check]')).toHaveLength(0);
  });

  it('flags in the panel an account that leaves out the commands and failures the steps show', async () => {
    const { panel } = await open(codeMapRun(audit({ examined: ['packages/myco/src/runner/loop.ts', '…'] })));
    expect(panel.querySelector('[data-account-elided]')!.textContent).toBe('1 entry isn’t a file path, so it isn’t shown.');
    expect(panel.querySelector('[data-audit-check="unsettled"]')!.textContent).toBe('Can’t compare one entry the agent lists as examined: it isn’t a file path.');
    const checks = within(panel).getByRole('region', { name: 'Its account against what was seen' });
    const flags = [...checks.querySelectorAll('[data-audit-check="flag"]')].map((li) => li.textContent);
    expect(flags).toEqual([
      'The worker saw 1 command run; the agent’s account lists no commands.',
      '1 step failed; the agent’s account lists no failures.',
    ]);
  });
});

describe('a step log longer than a page', () => {
  it('pages all 250 steps without loss and shows the true total', async () => {
    seq = 0;
    const steps = Array.from({ length: 250 }, (_, i) => step({ kind: 'read', tool: 'Read', target: `src/file-${i}.ts` }));
    const latest = attempt('att-long', T0, steps);
    const detail = runDetail(mapRun, {
      run: { task: 'canopy-map' }, attempts: [latest], attemptCount: 1,
      steps: { attemptId: latest.attemptId, rows: steps.slice(0, 200), cursor: 'steps-page-2' },
    });
    const { panel, asked } = await open(detail, {
      [`/api/projects/${P}/runs/${RUN}/steps`]: (url) => Response.json(url.searchParams.get('cursor') === 'steps-page-2'
        ? { attemptId: latest.attemptId, rows: steps.slice(200), cursor: null }
        : { attemptId: latest.attemptId, rows: [], cursor: null }),
    });
    const did = within(panel).getByRole('region', { name: 'What it did' });
    await waitFor(() => expect(did.textContent).toContain('Showing 200 of 250 steps'));
    fireEvent.click(within(did).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(did).getAllByRole('listitem')).toHaveLength(250));
    expect(within(did).queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(did.textContent).toContain('250 steps');
    const shown = within(did).getAllByRole('listitem').map((li) => /src\/file-(\d+)\.ts/.exec(li.textContent ?? '')?.[1]);
    expect(shown).toEqual(steps.map((_, i) => String(i)));
    expect(asked.some((url) => url.pathname.endsWith('/steps') && url.searchParams.get('attempt') === 'att-long' && url.searchParams.get('cursor') === 'steps-page-2' && url.searchParams.get('limit') === '200')).toBe(true);
    expect(within(panel).getByRole('region', { name: 'Files it read' }).textContent).toContain('250 files');
    expect(panel.querySelector('[data-run-summary]')!.textContent).toBe('Read 250 files.');
  });
});

describe('checks of the agent’s account', () => {
  seq = 0;
  const command = step({ kind: 'command', tool: 'Bash', target: 'cd packages/app && npm test' });
  const read = step({ kind: 'read', tool: 'Read', target: '/repo/src/core/runs.ts' });
  const failed = step({ kind: 'command', tool: 'Bash', target: 'git status', outcome: 'error', exitCode: 1 });
  const steps = [command, read, failed];
  const rows = attemptActivity([], steps);
  const matching = audit({ commands: ['npm test', 'git status'], examined: ['src/core'], failures: [{ what: 'git status failed', recovery: '' }] });

  it('stays silent when the steps match the account', () => {
    expect(auditChecks(matching, rows, steps, complete(steps))).toEqual([]);
  });

  it('flags a kind of step the account leaves out: commands, files read, failures', () => {
    const checks = auditChecks(audit(), rows, steps, complete(steps));
    expect(checks).toEqual([
      { verdict: 'flag', words: 'The worker saw 2 commands run; the agent’s account lists no commands.' },
      { verdict: 'flag', words: 'The worker saw 1 file read; the agent’s account lists none as examined.' },
      { verdict: 'flag', words: '1 step failed; the agent’s account lists no failures.' },
    ]);
  });

  it('flags a command or file the account lists that no step names', () => {
    const checks = auditChecks({ ...matching, commands: [...matching.commands, 'npm run build'], examined: [...matching.examined, 'docs/guide.md'] }, rows, steps, complete(steps));
    expect(checks).toEqual([
      { verdict: 'flag', words: 'The agent’s account lists the command “npm run build”; the worker saw no such command.' },
      { verdict: 'flag', words: 'The agent’s account lists docs/guide.md as examined; the worker saw no step on it.' },
    ]);
  });

  it('says it can’t compare where a shaped form keeps no word, never flagging it', () => {
    const checks = auditChecks({ ...matching, commands: ['npm …'], examined: [...matching.examined, '…'] }, rows, steps, complete(steps));
    expect(checks.map((check) => check.verdict)).toEqual(['unsettled', 'unsettled']);
    expect(checks[0]!.words).toBe('Can’t compare the command “npm …” with what the worker saw: part of it isn’t kept.');
    expect(checks[1]!.words).toBe('Can’t compare one entry the agent lists as examined: it isn’t a file path.');
    expect(compareCommand('npm test', 'npm …')).toBe('unsettled');
    expect(compareCommand('git …', 'npm test')).toBe('different');
    expect(compareCommand('npm test', 'cd x && npm test')).toBe('same');
    expect(comparePath('src/core', '/repo/src/core/runs.ts')).toBe('same');
    expect(comparePath('src/x.ts', '…')).toBe('unsettled');
  });

  it('says it can’t compare a claim with no step while the step log is incomplete', () => {
    const partial = coverageOf(attempt('a', T0, steps, { total: 5, received: 3 }), 3, true);
    const checks = auditChecks({ ...matching, commands: ['npm run build'] }, rows, steps, partial);
    expect(checks).toEqual([{ verdict: 'unsettled', words: 'Can’t compare the command “npm run build”: the step log is incomplete.' }]);
  });

  it('checks only the failures where Myco holds no step log', () => {
    const calls = [call(1, 'myco_run_map', 'write', T0, 'no')];
    const callRows = attemptActivity(calls, []);
    const checks = auditChecks(audit({ commands: ['npm test'] }), callRows, [], coverageOf(null, 0, true));
    expect(checks).toEqual([
      { verdict: 'flag', words: '1 call failed; the agent’s account lists no failures.' },
      { verdict: 'unsettled', words: 'Can’t compare the commands and files the agent lists with its steps: Myco holds no step log for this attempt.' },
    ]);
  });
});

describe('evidence that is missing, pending or partial', () => {
  const noRead = /read no files|saw no file reads\.|read nothing|didn’t read any/i;

  it('never says a run read nothing while its step log is pending', async () => {
    const detail = runDetail(mapRun, { run: { task: 'canopy-map' }, attempts: [attempt('att-wait', T0, null)], attemptCount: 1, steps: null, toolCalls: [call(1, 'myco_run_map', 'get', T0 + 1_000)] });
    const { panel } = await open(detail);
    const files = within(panel).getByRole('region', { name: 'Files it read' });
    expect(files.getAttribute('data-run-files')).toBe('pending');
    expect(files.textContent).toContain('isn’t known yet');
    expect(panel.textContent).not.toMatch(noRead);
    expect(within(panel).getByRole('region', { name: 'What it did' }).textContent).toContain('step log hasn’t arrived');
  });

  it('never says a run read nothing while its step log is partial', async () => {
    seq = 0;
    const steps = [step({ kind: 'command', tool: 'Bash', target: 'ls' })];
    const latest = attempt('att-part', T0, steps, { total: 4, received: 1, overflow: 3 });
    const { panel } = await open(runDetail(mapRun, { run: { task: 'canopy-map' }, attempts: [latest], attemptCount: 1, steps: { attemptId: latest.attemptId, rows: steps, cursor: null } }));
    const files = within(panel).getByRole('region', { name: 'Files it read' });
    expect(files.getAttribute('data-run-files')).toBe('partial');
    expect(files.textContent).toContain('it may have read files');
    expect(panel.textContent).not.toMatch(noRead);
    const did = within(panel).getByRole('region', { name: 'What it did' });
    expect(did.textContent).toContain('1 of the 4 steps the worker saw have arrived.');
    expect(did.textContent).toContain('The worker saw 3 more steps than a step log keeps; they aren’t listed.');
  });

  it('reads unread records as partial evidence: no "every step" claim, no definite "no file reads", and claims it can’t compare', async () => {
    seq = 0;
    const steps = [step({ kind: 'command', tool: 'Bash', target: 'ls' })];
    const latest = attempt('att-odd', T0, steps, { unrecognized: { total: 2, shapes: { mystery: 2 } } });
    const { panel } = await open(runDetail(mapRun, {
      run: { task: 'canopy-map' }, attempts: [latest], attemptCount: 1, steps: { attemptId: latest.attemptId, rows: steps, cursor: null },
      reports: [{ action: 'report', summary: 'Mapped.', details: null, audit: audit({ commands: ['ls', 'npm run build'], examined: ['docs/a.md'] }), createdAt: T0 + 9_000 }],
    }));
    const did = within(panel).getByRole('region', { name: 'What it did' });
    expect(did.querySelector('[data-coverage="partial"]')!.textContent).toContain('The worker couldn’t read 2 records of the agent’s output that might have held a step');
    expect(did.textContent).not.toContain('Every step the worker saw is listed.');
    const files = within(panel).getByRole('region', { name: 'Files it read' });
    expect(files.getAttribute('data-run-files')).toBe('partial');
    expect(files.textContent).not.toContain('The worker saw no file reads.');
    expect(files.textContent).toContain('it may have read files');
    const checks = [...panel.querySelectorAll('[data-audit-check]')].map((li) => [li.getAttribute('data-audit-check'), li.textContent]);
    expect(checks).toEqual([
      ['unsettled', 'Can’t compare the command “npm run build”: the step log is incomplete.'],
      ['unsettled', 'Can’t compare docs/a.md: the step log is incomplete.'],
    ]);
  });

  it('renders a run from before step logs honestly, from Myco’s own record alone', async () => {
    const calls = [call(1, 'myco_run_map', 'get', T0), call(2, 'myco_run_map', 'write', T0 + 1, 'Map text must be a bounded nonempty line.'), call(3, 'myco_run_map', 'write', T0 + 2), call(4, 'myco_run', 'report', T0 + 3)];
    const { panel } = await open(runDetail(mapRun, { run: { task: 'canopy-map', result: 'produced' }, toolCalls: calls, read: { sessions: [], total: 0, recorded: true }, reports: [{ action: 'report', summary: 'Updated.', details: null, createdAt: T0 + 3 }] }));
    const did = within(panel).getByRole('region', { name: 'What it did' });
    expect(did.querySelector('[data-coverage="unavailable"]')!.textContent).toContain('Myco kept no step log for this run');
    expect(within(did).getAllByRole('listitem')).toHaveLength(4);
    expect(within(panel).getByRole('region', { name: 'Files it read' }).textContent).toContain('isn’t recorded');
    expect(panel.textContent).not.toMatch(noRead);
    expect(panel.querySelector('[data-run-summary]')!.textContent).toBe('Called Myco 4 times and saved the code map; 1 call failed.');
    expect(panel.querySelector('[data-account-missing]')).toBeNull();
  });
});

describe('a reclaimed run', () => {
  it('shows each attempt with its own steps, and why the first was replaced', async () => {
    seq = 0;
    const first = [step({ kind: 'read', tool: 'Read', target: 'old/first.ts' }), step({ kind: 'myco', tool: 'mcp__myco__myco_run_map', target: 'get' })];
    const second = [step({ kind: 'read', tool: 'Read', target: 'new/second.ts' })];
    const a1 = attempt('att-one', T0, first, {}, { kind: 'runner', runnerId: 'rn_mini', name: 'homelab-mini' });
    const a2 = attempt('att-two', T0 + 10 * MINUTE, second);
    const detail = runDetail(mapRun, {
      run: { task: 'canopy-map' }, attempts: [a1, a2], attemptCount: 2,
      steps: { attemptId: a2.attemptId, rows: second, cursor: null },
      toolCalls: [call(1, 'myco_run_map', 'get', T0 + 2_100)],
    });
    const { panel, asked } = await open(detail, {
      [`/api/projects/${P}/runs/${RUN}/steps`]: (url) => Response.json(url.searchParams.get('attempt') === 'att-one' ? { attemptId: 'att-one', rows: first, cursor: null } : { attemptId: 'att-two', rows: second, cursor: null }),
    });
    const did = within(panel).getByRole('region', { name: 'What it did' });
    const attempts = within(did).getByRole('list', { name: 'Attempts' });
    const items = [...attempts.children] as HTMLElement[];
    expect(items.map((li) => li.getAttribute('data-attempt'))).toEqual(['replaced', 'latest']);
    expect(items[0]!.querySelector('[data-attempt-replaced]')!.textContent).toContain('It stopped checking in, so Myco gave the run to a new attempt');
    expect(items[1]!.textContent).toContain('Attempt 2 of 2');
    expect(within(items[0]!).getByRole('button', { name: /Attempt 1 of 2/ }).textContent).toContain('on homelab-mini');
    expect(items[1]!.textContent).not.toContain(' · on ');
    expect(items[1]!.textContent).toContain('Read new/second.ts');
    expect(items[1]!.textContent).not.toContain('old/first.ts');
    fireEvent.click(within(items[0]!).getByRole('button', { name: /Attempt 1 of 2/ }));
    await waitFor(() => expect(items[0]!.textContent).toContain('Read old/first.ts'));
    expect(within(items[0]!).getAllByRole('listitem')).toHaveLength(2);
    expect(items[0]!.querySelector('[data-activity-seen="both"]')!.textContent).toContain('Read the code map');
    expect(asked.some((url) => url.pathname.endsWith('/steps') && url.searchParams.get('attempt') === 'att-one')).toBe(true);
    expect(panel.querySelector('[data-run-summary]')!.textContent).toBe('In its last of 2 attempts: read 1 file.');
  });
});

describe('the summary line', () => {
  it('counts files, searches, commands, edits and what Myco kept, then failures and retries', () => {
    seq = 0;
    const steps = [
      step({ kind: 'read', tool: 'Read', target: 'a.ts' }), step({ kind: 'read', tool: 'Read', target: 'a.ts' }), step({ kind: 'read', tool: 'Read', target: '…' }),
      step({ kind: 'edit', tool: 'Edit', target: 'b.ts' }), step({ kind: 'command', tool: 'Bash', target: 'npm test', outcome: 'error', exitCode: 1 }),
      step({ kind: 'command', tool: 'Bash', target: 'npm test' }), step({ kind: 'command', tool: 'Bash', target: 'npm run lint', outcome: 'error', exitCode: 2 }),
    ];
    const rows = attemptActivity([call(1, 'myco_spores', 'save', T0), call(2, 'myco_spores', 'save', T0 + 1)], steps);
    const files = filesRead(steps);
    expect(files).toEqual({ paths: ['a.ts'], unnamed: 1 });
    expect(summaryWords(rows, true, files)).toBe('Read 2 files, ran 3 commands, edited 1 file and saved 2 spores; 2 steps failed, 1 of them retried.');
  });
});

it('never counts a command the agent wasn’t allowed to run as run, and names the refusal as one', () => {
  seq = 0;
  const steps = [step({ kind: 'read', tool: 'Read', target: 'a.ts' }), step({ kind: 'command', tool: 'Bash', target: 'echo … | python3 -c …', outcome: 'refused' })];
  const rows = attemptActivity([], steps);
  expect(summaryWords(rows, true, filesRead(steps))).toBe('Read 1 file; 1 step wasn’t allowed.');
  expect(auditChecks(audit({ examined: ['a.ts'] }), rows, steps, complete(steps))).toEqual([
    { verdict: 'flag', words: '1 step wasn’t allowed; the agent’s account lists no failures.' },
  ]);
});

it('renders a row of each kind in reader words, a tool by what its manifest says it did or by its name in plain words', () => {
  seq = 0;
  const kinds: RunStep[] = [
    step({ kind: 'fetch', tool: 'WebFetch', target: 'https://example.com' }),
    step({ kind: 'tool', tool: 'ToolSearch', target: null }),
    step({ kind: 'command', tool: 'Bash', target: '…', outcome: 'refused' }),
    step({ kind: 'read', tool: 'Read', target: 'x.ts', outcome: 'unfinished' }),
    step({ kind: 'tool', tool: 'NotebookFrobnicate', target: null }),
    step({ kind: 'tool', tool: 'other', target: null }),
  ];
  const rows = attemptActivity([], kinds, 'claude-code');
  expect(rows.map((row) => [row.lead, row.target, row.state])).toEqual([
    ['Looked up', 'https://example.com', 'ok'], ['Looked up a tool', null, 'ok'], ['Ran a command', null, 'refused'], ['Read', 'x.ts', 'unfinished'],
    ['Used notebook frobnicate', null, 'ok'], ['Used a tool', null, 'ok'],
  ]);
  expect(attemptActivity([], [{ ...kinds[1]!, tool: 'think' }], 'opencode')[0]!.lead).toBe('Thought it through');
  expect(rows[2]!.reason).toBe('The agent wasn’t allowed to use this tool.');
});

describe('commands compared only where provably different', () => {
  it('matches a claim found among a command’s words in order: a claim may leave out flags and paths', () => {
    expect(compareCommand('npm test', 'npm test -- tests/a.test.ts')).toBe('same');
    expect(compareCommand('git log', 'git log --oneline -- src/')).toBe('same');
    expect(compareCommand('npm run build', 'npm test -- tests/a.test.ts')).toBe('unsettled');
    expect(compareCommand('npm run build', 'npm test')).toBe('different');
  });

  it('can’t compare a command whose later lines were dropped, and never flags a claim they could hold', () => {
    const seen = commandShape('npm test\nnpm run lint')!;
    expect(seen).toBe('npm test …');
    expect(compareCommand('npm run lint', 'npm test\nnpm run lint')).toBe('unsettled');
    expect(compareCommand('npm test\nnpm run lint', 'npm test')).toBe('unsettled');
    seq = 0;
    const steps = [step({ kind: 'command', tool: 'Bash', target: seen })];
    expect(auditChecks(audit({ commands: ['npm run lint'] }), attemptActivity([], steps), steps, complete(steps))).toEqual([
      { verdict: 'unsettled', words: 'Can’t compare the command “npm run lint” with what the worker saw: part of it isn’t kept.' },
    ]);
  });
});

describe('a failed step tried again', () => {
  it('is a retry only on the same shaped target; a later call to the same Myco operation is not counted as one', () => {
    seq = 0;
    const steps = [
      step({ kind: 'command', tool: 'Bash', target: 'npm test', outcome: 'error', exitCode: 1 }),
      step({ kind: 'command', tool: 'Bash', target: 'npm test' }),
      step({ kind: 'command', tool: 'Bash', target: 'npm …', outcome: 'error', exitCode: 1 }),
      step({ kind: 'command', tool: 'Bash', target: 'npm …' }),
    ];
    const calls = [call(1, 'myco_spores', 'save', T0 + 100_000, 'too long'), call(2, 'myco_spores', 'save', T0 + 200_000)];
    const rows = attemptActivity(calls, steps);
    expect(rows.map((row) => [row.state, row.retried, row.laterSuccess])).toEqual([
      ['failed', true, false], ['ok', false, false], ['failed', false, false], ['ok', false, false],
      ['failed', false, true], ['ok', false, false],
    ]);
    expect(summaryWords(rows, true, filesRead(steps))).toBe('Ran 4 commands and saved 1 spore; 3 steps failed, 1 of them retried.');
  });
});

describe('pairing a step with its Myco call', () => {
  it('pairs by the nearest recorded time, so a call Myco did not record leaves the others paired', () => {
    seq = 0;
    const first = step({ kind: 'myco', tool: 'mcp__myco__myco_run_map', target: 'get' });
    const second = { ...step({ kind: 'myco', tool: 'mcp__myco__myco_run_map', target: 'get' }), startedAt: T0 + 60_000, endedAt: T0 + 60_400 };
    const rows = attemptActivity([call(7, 'myco_run_map', 'get', T0 + 60_300)], [first, second]);
    expect(rows.map((row) => [row.step?.seq ?? null, row.call?.id ?? null])).toEqual([[0, null], [1, 7]]);
  });

  it('never pairs a call recorded far from every step of its operation', () => {
    seq = 0;
    const only = step({ kind: 'myco', tool: 'mcp__myco__myco_run_map', target: 'get' });
    const rows = attemptActivity([call(9, 'myco_run_map', 'get', only.startedAt + 10 * MINUTE)], [only]);
    expect(rows.map((row) => [row.step?.seq ?? null, row.call?.id ?? null])).toEqual([[0, null], [null, 9]]);
  });

  it('pairs calls that finished out of order with the steps that made them', () => {
    seq = 0;
    const slow = { ...step({ kind: 'myco', tool: 'mcp__myco__myco_spores', target: 'save' }), startedAt: T0, endedAt: T0 + 4_000 };
    const quick = { ...step({ kind: 'myco', tool: 'mcp__myco__myco_spores', target: 'save' }), startedAt: T0 + 100, endedAt: T0 + 300 };
    const rows = attemptActivity([call(1, 'myco_spores', 'save', T0 + 250), call(2, 'myco_spores', 'save', T0 + 3_950, 'slow one refused')], [slow, quick]);
    expect(rows.map((row) => [row.step?.seq ?? null, row.call?.id ?? null, row.state])).toEqual([[0, 2, 'failed'], [1, 1, 'ok']]);
  });

  it('pairs an agent-protocol harness’s Myco steps as it does any other, and says so where a worker named none', () => {
    seq = 0;
    const acpStep = step({ kind: 'myco', tool: 'mcp__myco__myco_run_map', target: 'write' });
    const rows = attemptActivity([call(3, 'myco_run_map', 'write', acpStep.startedAt + 100)], [acpStep], 'opencode');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.call?.id).toBe(3);
    const unnamed = [step({ kind: 'tool', tool: 'other', target: null })];
    const coverage = complete(unnamed);
    const calls = [call(4, 'myco_run_map', 'write', T0)];
    expect(mycoUnnamed(coverage, unnamed, calls)).toBe(true);
    expect(coverageWords(coverage, false, true)).toContain('The worker couldn’t tell which of its steps were calls to Myco, so Myco’s own record of those calls is listed apart.');
    expect(mycoUnnamed(coverage, [acpStep], calls)).toBe(false);
  });
});

describe('evidence Myco can’t place or load', () => {
  it('can’t compare an account it can’t place in an attempt, never checking it against the first', async () => {
    expect(attemptAt([{ claimedAt: T0 }], T0 - 1)).toBe(-1);
    const detail = codeMapRun();
    detail.reports = [{ ...detail.reports[0]!, createdAt: T0 - 60_000 }];
    const { panel } = await open(detail);
    const checks = within(panel).getByRole('region', { name: 'Its account against what was seen' });
    expect(checks.getAttribute('data-audit-checks')).toBe('unplaced');
    expect(checks.textContent).toContain('Can’t compare: Myco can’t tell which attempt this account closed.');
  });

  it('reads a step log it could not load as unavailable, never as the steps that arrived', async () => {
    seq = 0;
    const steps = Array.from({ length: 3 }, (_, i) => step({ kind: 'command', tool: 'Bash', target: `ls dir${i}/` }));
    const latest = attempt('att-broken', T0, steps, { total: 300, received: 300 });
    const { panel } = await open(runDetail(mapRun, { run: { task: 'canopy-map' }, attempts: [latest], attemptCount: 1, steps: { attemptId: latest.attemptId, rows: steps, cursor: 'more' } }), {
      [`/api/projects/${P}/runs/${RUN}/steps`]: () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 500 }),
    });
    const files = await within(panel).findByRole('region', { name: 'Files it read' });
    await waitFor(() => expect(files.getAttribute('data-run-files')).toBe('unavailable'));
    expect(files.textContent).toContain('its step log couldn’t be loaded');
    expect(panel.textContent).not.toContain('among the steps');
    expect(within(panel).getByRole('region', { name: 'What it did' }).querySelector('[data-coverage="unavailable"]')!.textContent).toContain('couldn’t be loaded');
  });
});
