import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris' } };
const PROJECTS = { projects: [{ projectId: 'x', name: 'Project X', createdAt: 0, sessionCount: 0, lastActivityAt: null }] };
const NOW = Date.now();

const run = (over: Record<string, unknown> = {}) => ({
  id: 'r1', agentId: 'agent_1', task: 'digest', status: 'completed', provider: 'anthropic', model: 'claude', startedAt: NOW - 60_000, resumedAt: null, completedAt: NOW,
  tokensUsed: 1200, costUsd: 0.02, costSource: 'actual', dryRun: false, resumable: false, resumeStatus: null, failed: false, ...over,
});
const detail = (over: Record<string, unknown> = {}, phases: unknown = [], reports: unknown[] = [], toolCalls: unknown[] = []) => ({
  run: { ...run(over), instruction: null, sessionRef: null, actualCostUsd: null, estimatedCostUsd: null, reasoningLevel: null, resumeMode: null, resumeAttempts: 0, error: null, dispatchedBy: null, usageData: null, actionsTaken: null, ...over },
  phases, reports, toolCalls, projectId: 'x',
});

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

/** One stubbed endpoint; it is handed the request's own options so a test can read what the page asked for. */
type Endpoint = (init?: RequestInit) => Response | Promise<Response>;

function server(routes: Record<string, Endpoint>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(href, 'https://s').pathname;
    const endpoint = routes[pathname];
    return endpoint === undefined ? new Response(null, { status: 404 }) : endpoint(init);
  }) as typeof fetch;
}

const base = (extra: Record<string, Endpoint> = {}) => ({
  '/auth/me': () => Response.json(ME),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/agents': () => Response.json({ agents: [{ id: 'agent_1', name: 'Myco agent', provider: 'anthropic', model: 'claude', enabled: true }] }),
  '/api/projects/x/activity': () => Response.json({ items: [], stats: { sessions: 0, openSessions: 0, sessionsLast7d: 0, prompts: 0, toolCalls: 0, plans: 0, attachments: 0, lastActivityAt: null } }),
  '/api/projects/x/plans': () => Response.json({ plans: [], maxPage: 200 }),
  ...extra,
});

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

describe('Agent runs', () => {
  it('queues the selected memory task for this project and opens its actual run', async () => {
    let request: { method?: string; body: unknown } | undefined;
    let queued = false;
    server(base({
      '/api/projects/x/runs': () => Response.json({ rows: queued ? [run({ id: 'seed_run', task: 'vault-seed', status: 'queued', queuedAt: NOW, heldBy: 'worker', position: 0 })] : [], cursor: null }),
      '/api/harness/dispatch': (init) => {
        request = { method: init?.method, body: JSON.parse(String(init?.body)) };
        queued = true;
        return Response.json({ runId: 'seed_run', projectId: 'x', queued: true });
      },
      '/api/projects/x/runs/seed_run': () => Response.json(detail({ id: 'seed_run', task: 'vault-seed', status: 'queued' })),
    }));
    mount('/p/x/runs');
    fireEvent.change(await screen.findByLabelText('Memory task'), { target: { value: 'vault-seed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));
    expect(await screen.findByText(/Task queued for a worker/)).toBeTruthy();
    expect(request).toEqual({ method: 'POST', body: { projectId: 'x', task: 'vault-seed' } });
    await screen.findByRole('row');
    fireEvent.click(screen.getByRole('link', { name: 'View run' }));
    expect(await screen.findByText('seed_run')).toBeTruthy();
  });

  it('shows the server refusal and permits a deliberate retry', async () => {
    let attempts = 0;
    server(base({
      '/api/projects/x/runs': () => Response.json({ rows: [], cursor: null }),
      '/api/harness/dispatch': () => { attempts++; return Response.json({ error: 'bad_request', reason: 'this Project is not admitted to that capability' }, { status: 400 }); },
    }));
    mount('/p/x/runs');
    fireEvent.click(await screen.findByRole('button', { name: 'Run task' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not admitted');
    expect(screen.queryByRole('link', { name: 'View run' })).toBeNull();
    expect(attempts).toBe(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run task' }).hasAttribute('disabled')).toBe(false));
  });

  it('explains an unchanged result without inventing a run', async () => {
    server(base({
      '/api/projects/x/runs': () => Response.json({ rows: [], cursor: null }),
      '/api/harness/dispatch': () => Response.json({ outcome: 'unchanged' }),
    }));
    mount('/p/x/runs');
    fireEvent.click(await screen.findByRole('button', { name: 'Run task' }));
    expect(await screen.findByText('The source material is unchanged. No run was created.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'View run' })).toBeNull();
  });

  it('does not link a run returned for another project', async () => {
    server(base({
      '/api/projects/x/runs': () => Response.json({ rows: [], cursor: null }),
      '/api/harness/dispatch': () => Response.json({ runId: 'wrong_run', projectId: 'other', queued: true }),
    }));
    mount('/p/x/runs');
    fireEvent.click(await screen.findByRole('button', { name: 'Run task' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Check the run list');
    expect(screen.queryByRole('link', { name: 'View run' })).toBeNull();
  });

  it('shows a project that has run nothing as empty, not missing', async () => {
    server(base({ '/api/projects/x/runs': () => Response.json({ rows: [], cursor: null }) }));
    mount('/p/x/runs');
    expect(await screen.findByText(/No runs yet/)).toBeTruthy();
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  it('shows a failed run as failed with its record, and a completed run with none', async () => {
    server(base({
      '/api/projects/x/runs': () => Response.json({ rows: [run({ id: 'r_failed', status: 'failed', failed: true }), run()], cursor: null }),
      '/api/projects/x/runs/r_failed': () => Response.json(detail({ id: 'r_failed', status: 'failed', failed: true, error: 'the model refused', resumeStatus: 'session_expired' }, [
        { name: 'prepare', status: 'completed', updatedAt: 1, summary: null, turnsUsed: 2, allowedMaxTurns: 5, tokensUsed: 10, costUsd: 0.01, costSource: 'actual', capHit: false, semanticCheckBlocked: false, postConditionFailed: false },
        { name: 'write', status: 'failed', updatedAt: 2, summary: 'ran out of turns', turnsUsed: null, allowedMaxTurns: null, tokensUsed: null, costUsd: null, costSource: null, capHit: true, semanticCheckBlocked: false, postConditionFailed: false },
      ], [{ id: 1, runId: 'r_failed', agentId: 'agent_1', action: 'noted', summary: 'a report', details: null, createdAt: NOW }])),
      '/api/projects/x/runs/r1': () => Response.json(detail()),
    }));
    mount('/p/x/runs/r_failed');
    expect(await screen.findByTestId('failure-record')).toBeTruthy();
    expect(screen.getByText('the model refused')).toBeTruthy();
    expect(screen.getByText(/provider session expired/)).toBeTruthy();
    expect(screen.getByText('turn cap hit')).toBeTruthy();
    expect(screen.getByText('ran out of turns')).toBeTruthy();
    expect(screen.getByText('a report')).toBeTruthy();
    expect(screen.getByText('Myco agent')).toBeTruthy();
  });

  it('opens a completed run from the list with no failure record', async () => {
    server(base({
      '/api/projects/x/runs': () => Response.json({ rows: [run({ id: 'r_failed', status: 'failed', failed: true }), run()], cursor: null }),
      '/api/projects/x/runs/r1': () => Response.json(detail()),
    }));
    mount('/p/x/runs');
    const rows = await screen.findAllByRole('row');
    expect(rows.map((r) => r.textContent?.includes('failed'))).toEqual([true, false]);
    fireEvent.click(rows[1]!);
    await screen.findByText('No phases recorded.');
    expect(screen.queryByTestId('failure-record')).toBeNull();
  });

  it('shows the record of a run that completed but recorded an error', async () => {
    server(base({
      '/api/projects/x/runs': () => Response.json({ rows: [run({ failed: true })], cursor: null }),
      '/api/projects/x/runs/r1': () => Response.json(detail({ failed: true, error: 'a tool refused' })),
    }));
    mount('/p/x/runs/r1');
    expect(await screen.findByTestId('failure-record')).toBeTruthy();
    expect(screen.getByText('This run recorded an error')).toBeTruthy();
    expect(screen.getByText('a tool refused')).toBeTruthy();
  });

  it('reads a run that never called back as having called nothing, and shows what it failed for', async () => {
    server(base({
      '/api/projects/x/runs': () => Response.json({ rows: [run({ status: 'failed', failed: true })], cursor: null }),
      '/api/projects/x/runs/r1': () => Response.json(detail({ status: 'failed', failed: true, error: 'the run ended without its report' })),
    }));
    mount('/p/x/runs/r1');
    expect(await screen.findByTestId('no-tool-calls')).toBeTruthy();
    expect(screen.getByText('the run ended without its report')).toBeTruthy();
  });

  it('lists the calls a run made back to the Deployment', async () => {
    server(base({
      '/api/projects/x/runs': () => Response.json({ rows: [run()], cursor: null }),
      '/api/projects/x/runs/r1': () => Response.json(detail({}, [], [], [
        { tool: 'myco_run_sessions', op: 'material', durationMs: 12, recordedAt: NOW - 2000 },
        { tool: 'myco_run', op: 'report', durationMs: 3, recordedAt: NOW - 1000 },
      ])),
    }));
    mount('/p/x/runs/r1');
    const calls = await screen.findByLabelText('Calls back to this Deployment');
    expect(calls.textContent).toContain('myco_run_sessions');
    expect(calls.textContent).toContain('report');
    expect(screen.queryByTestId('no-tool-calls')).toBeNull();
  });

  it('tells an unreadable phase record apart from an empty one', async () => {
    server(base({
      '/api/projects/x/runs': () => Response.json({ rows: [run()], cursor: null }),
      '/api/projects/x/runs/r1': () => Response.json(detail({}, null)),
    }));
    mount('/p/x/runs/r1');
    expect(await screen.findByText(/phase record could not be read/)).toBeTruthy();
  });

  it('answers a run the server does not hold with not found, never forbidden', async () => {
    server(base({ '/api/projects/x/runs': () => Response.json({ rows: [], cursor: null }) }));
    mount('/p/x/runs/gone');
    expect(await screen.findByText(/not found/i)).toBeTruthy();
    expect(screen.queryByText(/forbidden/i)).toBeNull();
  });

  it('keeps the section active while a run is open, and only Overview active on the project home', async () => {
    server(base({ '/api/projects/x/runs': () => Response.json({ rows: [run()], cursor: null }), '/api/projects/x/runs/r1': () => Response.json(detail()) }));
    mount('/p/x/runs/r1');
    await screen.findByText('Facts');
    const nav = screen.getByRole('navigation', { name: 'Project' });
    const active = [...nav.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent);
    expect(active).toEqual(['Agent runs']);
  });

  it('marks Overview alone active on the project home', async () => {
    server(base());
    mount('/p/x');
    await screen.findByRole('heading', { name: 'Project X' });
    const nav = screen.getByRole('navigation', { name: 'Project' });
    expect([...nav.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent)).toEqual(['Overview']);
  });
});
