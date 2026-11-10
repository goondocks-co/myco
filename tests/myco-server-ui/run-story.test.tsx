/**
 * The run panel tells what a run did: "What happened" as a story with grouped calls, silence and how it ended, each
 * line marked with whose word it rests on; "Did it do what we asked?" from the evidence its task owes; and the other
 * tries of the same piece of work.
 *
 * The search fixture is shaped like the run that started #2149: eight calls in five seconds, then nothing until the
 * time limit, ended as if the machine had stopped responding.
 */
import { dashboardMe } from '../helpers/dashboard-permissions';
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import type { RunAttempt, RunCall, RunCloseEvidence, RunPageRow, RunStep } from '../../packages/myco-server/ui/src/features/work/wire';
import { ADMIN, MEMBERS, MINUTE, NOW, P, PROJECTS, runDetail, runRow, WEEK_WORK } from '../helpers/work-fixture';
import { TASK_DESCRIPTIONS } from './task-fixture';
import { rawIdsIn } from '../helpers/raw-ids';

const SECOND = 1_000;
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

async function open(runId: string, detail: unknown, taskRuns: (url: URL) => RunPageRow[] = () => []): Promise<HTMLElement> {
  const routes: Record<string, Endpoint> = {
    '/auth/me': () => Response.json(dashboardMe(ADMIN)),
    '/api/projects': () => Response.json(PROJECTS),
    '/api/members': () => Response.json(MEMBERS),
    '/api/attention': () => Response.json({ items: [], unavailable: [] }),
    '/api/tasks': () => Response.json({ tasks: TASK_DESCRIPTIONS }),
    '/api/tasks/names': () => Response.json({ tasks: TASK_DESCRIPTIONS.map(({ task, name }) => ({ task, name })) }),
    '/api/work': () => Response.json(WEEK_WORK),
    [`/api/projects/${P}/runs`]: (url) => Response.json({ rows: taskRuns(url), cursor: null }),
    [`/api/projects/${P}/capabilities`]: () => Response.json({ capabilities: { vault_evolution: true, canopy: true, cortex: true } }),
    [`/api/projects/${P}/runs/${runId}`]: () => Response.json(detail),
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    return routes[url.pathname]?.(url) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[`/p/${P}/work/runs/${runId}`]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
  const panel = await screen.findByTestId('run-panel');
  await within(panel).findByRole('heading', { level: 2 });
  return panel;
}

const runner = (runnerId: string, name: string): RunAttempt['executor'] => ({ kind: 'runner', runnerId, name });
const attempt = (attemptId: string, claimedAt: number, executor: RunAttempt['executor'], steps: RunAttempt['steps'] = null): RunAttempt => ({ attemptId, claimedAt, executor, steps });
const routeCall = (id: number, at: number): RunCall => ({ id, tool: '/runs/embedding-step', op: null, recordedAt: at, durationMs: null, status: 'success' });
const story = (panel: HTMLElement) => within(panel).getByRole('region', { name: 'What happened' });
const line = (panel: HTMLElement, key: string) => story(panel).querySelector<HTMLElement>(`[data-story-row="${key}"]`)!;
const verdict = (panel: HTMLElement) => within(panel).getByRole('region', { name: 'Did it do what we asked?' }).querySelector('[data-run-verdict]')!.textContent;

/** The search run from #2149: queued, claimed by homelab-mini, eight index steps in five seconds, then nothing until its limit. */
function searchRunCutOff() {
  const queued = NOW - 30 * MINUTE;
  const claimed = queued + 5 * SECOND;
  const calls = Array.from({ length: 8 }, (_, i) => routeCall(i + 1, claimed + 9 * SECOND + Math.round(i * 5 * SECOND / 7)));
  const lastCall = calls.at(-1)!.recordedAt;
  const ended = lastCall + 6 * MINUTE + 46 * SECOND;
  return runDetail(runRow({ id: 'run_embed1914', task: 'embedding-reconcile', status: 'failed', failed: true, queuedAt: queued, startedAt: claimed, completedAt: ended, harness: null, result: 'failed' }), {
    run: { errorCode: 'machine_unresponsive', error: 'the machine running it stopped responding' },
    attempts: [attempt('att_5e13c0b7', claimed, runner('rn_7f3a91c2', 'homelab-mini'))], attemptCount: 1,
    toolCalls: calls,
    outcomeEvidence: { hasReport: false, hasAudit: null, artifactPresent: null, skipSupported: null, targetSessionId: null },
  });
}

describe('What happened', () => {
  it('tells the cut-off search run as a story: claimed by its runner, eight calls as one row, the silence, and an end Myco inferred', async () => {
    const panel = await open('run_embed1914', searchRunCutOff());
    const text = story(panel).textContent!;
    expect(text).toContain('Queued, on its schedule');
    expect(within(line(panel, 'claim-att_5e13c0b7')).getByRole('link', { name: 'homelab-mini' }).getAttribute('href')).toBe('/runners#runner-rn_7f3a91c2');
    const grouped = story(panel).querySelectorAll('[data-story-row^="calls-"]');
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.textContent).toContain('Advanced the search index 8 times');
    expect(grouped[0]!.textContent).toContain('What each call did and how long it took were not recorded.');
    expect(text).toContain('Silence for 6 min 46 s');
    const inferred = line(panel, 'inferred');
    expect(inferred.textContent).toContain('No call for 6 min 46 s, past its time limit, so Myco ended it');
    expect(inferred.querySelector('[data-source]')!.textContent).toContain('Myco inferred');
    expect(line(panel, 'end').textContent).toContain('Ended as failed. No report filed');
    expect(panel.textContent).not.toContain('stopped responding');
    expect(rawIdsIn(panel)).toEqual([]);
    fireEvent.click(within(story(panel)).getByRole('button', { name: /Exact ids and codes/ }));
    const exact = panel.querySelector('[data-run-exact]')!.textContent!;
    expect(exact).toContain('run_embed1914');
    expect(exact).toContain('att_5e13c0b7');
    expect(exact).toContain('rn_7f3a91c2');
    expect(exact).toContain('machine_unresponsive');
  });

  it('marks each claim with whose word it rests on: Myco’s record, the runner’s step log, the agent’s report, and what was never recorded', async () => {
    const claimed = NOW - 20 * MINUTE;
    const steps: RunStep[] = [0, 1, 2].map((seq) => ({ seq, callId: null, kind: 'read', tool: 'Read', target: `/w/file-${seq}.ts`, outcome: 'ok', exitCode: null, startedAt: claimed + (seq + 2) * SECOND, endedAt: claimed + (seq + 2) * SECOND + 100 }));
    const detail = runDetail(runRow({ id: 'run_map0001', task: 'canopy-map', status: 'completed', queuedAt: claimed - SECOND, startedAt: claimed, completedAt: claimed + 40 * SECOND, result: 'produced' }), {
      attempts: [attempt('att_map', claimed, runner('rn_c04d11e8', 'studio-m4'), { total: 3, received: 3, overflow: 0, unrecognized: null })], attemptCount: 1,
      steps: { attemptId: 'att_map', rows: steps, cursor: null },
      toolCalls: [{ id: 1, tool: 'myco_run_map', op: 'write', recordedAt: claimed + 30 * SECOND, durationMs: 40, status: 'success' }],
      reports: [{ action: 'map', summary: 'Updated the code map.\nMore detail.', details: null, createdAt: claimed + 35 * SECOND }],
      outcomeEvidence: { hasReport: true, hasAudit: true, artifactPresent: true, skipSupported: null, targetSessionId: null },
    });
    const panel = await open('run_map0001', detail);
    const mark = (key: string) => line(panel, key).querySelector('[data-source]')!.textContent;
    expect(mark('claim-att_map')).toContain('Myco saw');
    expect(line(panel, 'steps').textContent).toContain('3 steps on the machine');
    expect(mark('steps')).toContain('Runner reports');
    expect(line(panel, 'report-0').textContent).toContain('Reported: Updated the code map.');
    expect(mark('report-0')).toContain('The agent says');
    expect(story(panel).textContent).not.toContain('Silence');
    const legend = within(panel).getByRole('region', { name: 'How we know' }).textContent!;
    for (const words of ['Myco saw', 'Runner reports', 'The agent says', 'Myco inferred', 'Not recorded']) expect(legend).toContain(words);
    const owed = within(panel).getByRole('region', { name: 'Did it do what we asked?' }).querySelector('[data-asked="owed"]')!.textContent!;
    expect(owed).toContain('Report and output both there');
    expect(owed).toContain('Myco saw');
  });

  it('says a step log that never arrived is not recorded, rather than that the run did nothing on its machine', async () => {
    const panel = await open('run_embed1914', searchRunCutOff());
    expect(line(panel, 'no-steps').textContent).toContain('The runner’s step log never arrived');
    expect(line(panel, 'no-steps').querySelector('[data-source]')!.textContent).toContain('Not recorded');
  });
});

describe('Did it do what we asked?', () => {

  it('tells a run that changed nothing, with Myco agreeing, apart from one that ran and did not do the work', async () => {
    const unchanged = runDetail(runRow({ id: 'run_same', task: 'title-summary', status: 'completed', result: 'unchanged', targetSessionId: 'sess_1' }), {
      reports: [{ action: 'skip', summary: 'A title already stands.', details: null, createdAt: NOW - 61 * MINUTE }],
      outcomeEvidence: evidence({ artifactPresent: null, skipSupported: true, targetSessionId: 'sess_1' }),
    });
    const same = await open('run_same', unchanged);
    expect(verdict(same)).toContain('Changed nothing, and Myco agrees');
    expect(same.querySelector('[data-asked="owed"]')!.textContent).toContain('Changed nothing, and Myco agrees');
    cleanup();

    const skipped = runDetail(runRow({ id: 'run_idle', task: 'title-summary', status: 'failed', failed: true, result: 'failed', targetSessionId: 'sess_1' }), {
      run: { errorCode: 'agent_tools_unused', error: 'the agent did not call Myco' },
      outcomeEvidence: evidence({ hasReport: false, hasAudit: false, artifactPresent: null, targetSessionId: 'sess_1' }),
    });
    const idle = await open('run_idle', skipped);
    expect(verdict(idle)).toContain('Ran and did not do the work');
    expect(verdict(idle)).not.toContain('Changed nothing');
    expect(idle.querySelector('[data-asked="owed"]')!.textContent).toContain('No report');
  });

  it('reads a run cut off by its time limit as stopped, not as one that did not do the work', async () => {
    const panel = await open('run_embed1914', searchRunCutOff());
    expect(verdict(panel)).toContain('Stopped before it finished the work');
  });
});

describe('the facts the panel states', () => {
  const searchRun = (id: string, over: Partial<RunPageRow>, reports: Array<{ action: string; summary: string; details: string | null; createdAt: number }> = []) =>
    runDetail(runRow({ id, task: 'embedding-reconcile', harness: null, ...over }), { reports, outcomeEvidence: evidence({ artifactPresent: null }) });

  it('says only that the time limit passed for a run Myco ended past it, in the banner and in the technical details', async () => {
    const panel = await open('run_embed1914', searchRunCutOff());
    expect(panel.querySelector('[data-run-failure]')!.textContent).toContain('Its time limit passed, so Myco ended it. Whether its machine stopped is not known.');
    fireEvent.click(within(panel.querySelector('[data-run-technical]') as HTMLElement).getByRole('button', { name: /Technical details/ }));
    expect(panel.querySelector('[data-run-technical]')!.textContent).not.toContain('stopped responding');
    expect(panel.textContent).not.toContain('heard nothing');
  });

  it('claims Myco agrees only where Myco checked a report of nothing to do, and says the output is there where it checked the output', async () => {
    const unchecked = await open('run_idle_index', searchRun('run_idle_index', { status: 'completed', result: 'unchanged' }, [
      { action: 'embedding', summary: 'Processed 0 embedding records; settled.', details: null, createdAt: NOW - 61 * MINUTE },
    ]));
    expect(verdict(unchecked)).toContain('Changed nothing');
    expect(verdict(unchecked)).not.toContain('agrees');
    expect(unchecked.querySelector('[data-asked="owed"]')!.textContent).not.toContain('agrees');
    cleanup();

    const current = runDetail(runRow({ id: 'run_map_current', task: 'canopy-map', status: 'completed', result: 'unchanged' }), {
      reports: [{ action: 'map', summary: 'The map is current.', details: null, createdAt: NOW - 61 * MINUTE }],
      outcomeEvidence: evidence({ artifactPresent: true }),
    });
    const map = await open('run_map_current', current);
    expect(verdict(map)).toContain('Did the work, and its output is there');
    expect(verdict(map)).not.toContain('agrees');
    expect(map.querySelector('[data-asked="owed"]')!.textContent).toContain('Report and output both there');
  });

  it('names the search index update a run recorded instead of saying it wrote nothing, and keeps a failed run’s output', async () => {
    const produced = await open('run_index_ok', searchRun('run_index_ok', { status: 'completed', result: 'produced' }, [
      { action: 'embedding', summary: 'Processed 340 embedding records; settled.', details: null, createdAt: NOW - 61 * MINUTE },
    ]));
    const made = within(produced).getByRole('region', { name: 'What it produced' }).textContent!;
    expect(made).toContain('An update to the search index. Its report: Processed 340 embedding records; settled.');
    expect(made).not.toContain('Nothing');
    cleanup();

    const kept = await open('run_index_kept', searchRun('run_index_kept', { status: 'failed', failed: true, result: 'failed_with_output' }));
    const keptWords = within(kept).getByRole('region', { name: 'What it produced' }).textContent!;
    expect(keptWords).toContain('An update to the search index.');
    expect(keptWords).toContain('It is kept.');
    expect(keptWords).not.toContain('stopped before writing anything');
  });

  it('marks a silence Myco measured between its own records as Myco saw, and an ending that changed nothing as Myco inferred', async () => {
    const cutOff = await open('run_embed1914', searchRunCutOff());
    const silence = story(cutOff).querySelector('[data-story-row="silence-end"]')!;
    expect(silence.textContent).toContain('Silence for 6 min 46 s');
    expect(silence.querySelector('[data-source]')!.textContent).toContain('Myco saw');
    expect(silence.textContent).toContain('Whether its runner kept checking in is not recorded');
    cleanup();

    const idle = await open('run_idle_index', searchRun('run_idle_index', { status: 'completed', result: 'unchanged' }));
    expect(line(idle, 'end').textContent).toContain('Completed, and changed nothing');
    expect(line(idle, 'end').querySelector('[data-source]')!.textContent).toContain('Myco inferred');
  });

  it('says a lapsed hold ran out, not that its runner stopped renewing it', async () => {
    const lapsed = runDetail(runRow({ id: 'run_lapsed', task: 'extract-curate', status: 'failed', failed: true, result: 'failed' }), {
      run: { errorCode: 'lease_lapsed', error: 'the lease lapsed' },
      attempts: [attempt('att_lapsed', NOW - 70 * MINUTE, runner('rn_b82ef603', 'cloud-vm-1'))], attemptCount: 1,
    });
    const panel = await open('run_lapsed', lapsed);
    expect(line(panel, 'inferred').textContent).toContain('Its hold on the run ran out, so Myco ended it');
    expect(panel.textContent).not.toContain('stopped renewing');
  });

  it('lists grouped calls once, under What happened, in the story’s words, with the route only in the facts panel', async () => {
    const panel = await open('run_embed1914', searchRunCutOff());
    const did = within(panel).getByRole('region', { name: 'What it did' });
    expect(did.textContent).not.toContain('Advanced the search index');
    expect(did.textContent).toContain('Myco’s calls are listed, grouped, under “What happened”.');
    const grouped = story(panel).querySelector('[data-story-row^="calls-"]') as HTMLElement;
    fireEvent.click(within(grouped).getByRole('button', { name: /Show the 8 calls/ }));
    expect(within(grouped).getAllByText(/Advanced the search index$/)).toHaveLength(8);
    for (const node of within(grouped).getAllByText(/\/runs\/embedding-step/)) expect(node.closest('[data-facts]')).not.toBeNull();
  });

  it('measures no silence while Myco’s list of calls is still incomplete', async () => {
    const detail = searchRunCutOff();
    const panel = await open('run_embed1914', { ...detail, toolCallCoverage: { total: 300, failed: 0, cursor: 'more' } });
    expect(story(panel).textContent).not.toContain('Silence');
    expect(story(panel).textContent).not.toContain('No call for');
    expect(line(panel, 'inferred').textContent).toContain('Its time limit passed, so Myco ended it');
  });
});

describe('Tries', () => {
  it('links one piece of work across its tries from the task’s run list', async () => {
    const cutOff = searchRunCutOff();
    const ended = cutOff.run.completedAt!;
    const earlier = runRow({ id: 'run_embed1904', task: 'embedding-reconcile', status: 'failed', failed: true, completedAt: ended - 10 * MINUTE });
    const before = runRow({ id: 'run_embed1800', task: 'embedding-reconcile', status: 'completed', completedAt: ended - 70 * MINUTE });
    const later = runRow({ id: 'run_embed1931', task: 'embedding-reconcile', status: 'completed', completedAt: ended + 11 * MINUTE });
    const panel = await open('run_embed1914', cutOff, (url) => url.searchParams.get('task') !== 'embedding-reconcile' ? []
      : Number(url.searchParams.get('until')) <= ended ? [earlier, before] : [later]);
    const tries = await within(panel).findByRole('region', { name: 'Tries' });
    expect(tries.textContent).toContain('One piece of work, 3 tries');
    const links = within(tries).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([`/p/${P}/work/runs/run_embed1904`, `/p/${P}/work/runs/run_embed1931`]);
    expect(tries.textContent).toContain('failed');
    expect(tries.textContent).toContain('(this one)');
    expect(tries.textContent).toContain('worked');
    expect(tries.textContent).not.toContain('run_embed1800');
  });

  it('shows no tries for a run whose neighbours are separate pieces of work', async () => {
    const done = runDetail(runRow({ id: 'run_done', task: 'canopy-map', status: 'completed', completedAt: NOW - HOUR_AGO }), { outcomeEvidence: evidence() });
    const panel = await open('run_done', done, (url) => url.searchParams.get('task') !== 'canopy-map' ? []
      : [runRow({ id: 'run_prev', task: 'canopy-map', status: 'completed', completedAt: NOW - 2 * HOUR_AGO })]);
    await waitFor(() => expect(story(panel).textContent).toContain('Completed'));
    expect(within(panel).queryByRole('region', { name: 'Tries' })).toBeNull();
  });
});

const HOUR_AGO = 60 * MINUTE;
function evidence(over: Partial<RunCloseEvidence> = {}): RunCloseEvidence {
  return { hasReport: true, hasAudit: true, artifactPresent: true, skipSupported: null, targetSessionId: null, ...over };
}
