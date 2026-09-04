import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const detail = (over: Record<string, unknown> = {}, phases: unknown = [], reports: unknown[] = []) => ({
  run: { ...run(over), instruction: null, sessionRef: null, actualCostUsd: null, estimatedCostUsd: null, reasoningLevel: null, resumeMode: null, resumeAttempts: 0, error: null, dispatchedBy: null, usageData: null, actionsTaken: null, ...over },
  phases, reports, projectId: 'x',
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
  ...extra,
});

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

describe('Agent runs', () => {
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

describe('Skills', () => {
  it('renders the published content, the lineage, and the release state that names this skill', async () => {
    server(base({
      '/api/projects/x/skills': () => Response.json({ skills: [{ id: 'sk1', agentId: 'agent_1', name: 'debugging', displayName: 'Debugging', description: 'How to debug here', status: 'active', generation: 2, sourceIds: '["a","b"]', usageCount: 3, lastUsedAt: NOW, createdAt: 0, updatedAt: 0 }] }),
      '/api/projects/x/skills/sk1': () => Response.json({ content: '# Debugging\n\nRead the **log** first.', lineage: [{ id: 'l2', skillId: 'sk1', generation: 2, action: 'evolve', rationale: 'new gotchas', sourceIdsAdded: '[]', contentSnapshot: '', createdAt: NOW }, { id: 'l1', skillId: 'sk1', generation: 1, action: 'generate', rationale: 'first cut', sourceIdsAdded: '[]', contentSnapshot: '', createdAt: NOW - 1 }] }),
      '/api/projects/x/release-states': () => Response.json({ releaseStates: [
        { id: 'rs2', namespace: 'skill', recordId: 'other', state: 'stale', confidence: 'high', basisKind: 'tag', basisRef: 'v1.0.0', basisSha: null, releasePrNumber: null, reason: null, checkedAt: NOW },
        { id: 'rs1', namespace: 'skill', recordId: 'sk1', state: 'released', confidence: 'high', basisKind: 'tag', basisRef: 'v1.4.8', basisSha: null, releasePrNumber: null, reason: null, checkedAt: NOW },
      ] }),
    }));
    mount('/p/x/skills/sk1');
    expect(await screen.findByText('Read the', { exact: false })).toBeTruthy();
    expect(screen.getByText('log')).toBeTruthy();
    expect(screen.getByText('new gotchas')).toBeTruthy();
    expect(screen.getByText('first cut')).toBeTruthy();
    expect(screen.getByTestId('release-state').textContent).toBe('released · v1.4.8 · high');
    expect(screen.getByText('2 sources')).toBeTruthy();
  });

  it('shows a project with no skills as empty', async () => {
    server(base({ '/api/projects/x/skills': () => Response.json({ skills: [] }) }));
    mount('/p/x/skills');
    expect(await screen.findByText(/No skills yet/)).toBeTruthy();
  });
});

describe('Cortex', () => {
  const instructionsRow = (over: Record<string, unknown> = {}) => ({
    id: 'agent_1:instructions', agentId: 'agent_1', content: '# Start here\n\nUse `npm test`.',
    inputHash: 'h', sourceRunId: 'run_9', generatedAt: NOW, counts: { sessions: 5, spores: 3, plans: 1 }, ...over,
  });

  it('renders the current instructions with the run that produced them, what they were written from, and an empty digest as empty', async () => {
    server(base({
      '/api/projects/x/cortex/instructions': () => Response.json({ instructions: [instructionsRow()] }),
      '/api/projects/x/digests': () => Response.json({ digests: [] }),
    }));
    mount('/p/x/cortex');
    expect(await screen.findByText('Start here')).toBeTruthy();
    expect(screen.getByText('from run run_9').getAttribute('href')).toBe('/p/x/runs/run_9');
    expect(screen.getByText('Written from 5 sessions, 3 spores, 1 plan')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Digest' }));
    expect(await screen.findByText(/No digest generated yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Code map' }));
    expect(await screen.findByText(/not available on this deployment yet/)).toBeTruthy();
  });

  it('says nothing was written from when the run recorded no counts', async () => {
    server(base({
      '/api/projects/x/cortex/instructions': () => Response.json({ instructions: [instructionsRow({ counts: null })] }),
      '/api/projects/x/digests': () => Response.json({ digests: [] }),
    }));
    mount('/p/x/cortex');
    expect(await screen.findByText('Start here')).toBeTruthy();
    expect(screen.queryByText(/Written from/)).toBeNull();
  });

  it('asks for the instructions again and names each outcome in the reader\'s words', async () => {
    const answers: Response[] = [
      Response.json({ runId: 'run_new', task: 'cortex-instructions', projectId: 'x', queued: false, timeoutSeconds: 300, provider: 'anthropic' }),
      Response.json({ runId: 'run_q', task: 'cortex-instructions', projectId: 'x', queued: true, heldBy: 'concurrent_runs' }),
      Response.json({ outcome: 'unchanged' }),
      Response.json({ error: 'max_runs_per_day', message: 'ceiling met' }, { status: 409 }),
    ];
    server(base({
      '/api/projects/x/cortex/instructions': () => Response.json({ instructions: [instructionsRow()] }),
      '/api/projects/x/digests': () => Response.json({ digests: [] }),
      '/api/harness/dispatch': () => answers.shift()!,
    }));
    mount('/p/x/cortex');
    const press = async () => fireEvent.click(await screen.findByRole('button', { name: /Refresh instructions/ }));

    await press();
    expect(await screen.findByText(/Writing new instructions/)).toBeTruthy();
    expect(screen.getByText('see the run').getAttribute('href')).toBe('/p/x/runs/run_new');

    await press();
    expect(await screen.findByText(/Waiting for a runtime/)).toBeTruthy();

    await press();
    expect(await screen.findByText('Nothing has changed since these were written')).toBeTruthy();

    await press();
    expect(await screen.findByText(/already been written once today/)).toBeTruthy();
  });

  it('shows a digest by tier and opens an earlier revision', async () => {
    server(base({
      '/api/projects/x/cortex/instructions': () => Response.json({ instructions: [] }),
      '/api/projects/x/digests': () => Response.json({ digests: [
        { id: 'd1', agentId: 'agent_1', tier: 1500, content: 'brief digest', substrateHash: null, generatedAt: NOW },
        { id: 'd2', agentId: 'agent_1', tier: 5000, content: 'full digest', substrateHash: null, generatedAt: NOW },
      ] }),
      '/api/projects/x/digests/1500/revisions': () => Response.json({ revisions: [{ id: 7, tier: 1500, content: 'older brief', metadata: null, runId: 'run_3', parentRevisionId: null, createdAt: NOW - 5 }] }),
      '/api/projects/x/digests/5000/revisions': () => Response.json({ revisions: [] }),
    }));
    mount('/p/x/cortex?tab=digest');
    expect(await screen.findByText('brief digest')).toBeTruthy();
    expect(await screen.findByText('older brief')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '5,000 tokens' }));
    expect(await screen.findByText('full digest')).toBeTruthy();
    expect(await screen.findByText('No earlier revisions.')).toBeTruthy();
  });

  it('asks for the digest again, from scratch when told to, and names each outcome in the reader\'s words', async () => {
    const asked: Array<Record<string, unknown>> = [];
    const answers: Response[] = [
      Response.json({ runId: 'run_d1', task: 'digest-only', projectId: 'x', queued: false, timeoutSeconds: 300, provider: 'anthropic' }),
      Response.json({ runId: 'run_d2', task: 'digest-only', projectId: 'x', queued: true, heldBy: 'concurrent_runs' }),
      Response.json({ error: 'max_runs_per_day', message: 'ceiling met' }, { status: 409 }),
    ];
    server(base({
      '/api/projects/x/cortex/instructions': () => Response.json({ instructions: [] }),
      '/api/projects/x/digests': () => Response.json({ digests: [
        { id: 'd1', agentId: 'agent_1', tier: 1500, content: 'brief digest', substrateHash: null, generatedAt: NOW },
      ] }),
      '/api/projects/x/digests/1500/revisions': () => Response.json({ revisions: [] }),
      '/api/harness/dispatch': (init?: RequestInit) => { asked.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return answers.shift()!; },
    }));
    mount('/p/x/cortex?tab=digest');
    const press = async () => fireEvent.click(await screen.findByRole('button', { name: /Regenerate digest/ }));

    await press();
    expect(await screen.findByText(/Writing the digest/)).toBeTruthy();
    expect(screen.getByText('see the run').getAttribute('href')).toBe('/p/x/runs/run_d1');

    fireEvent.click(screen.getByLabelText('From scratch'));
    await press();
    expect(await screen.findByText(/Waiting for a runtime/)).toBeTruthy();

    await press();
    expect(await screen.findByText(/already been written once today/)).toBeTruthy();
    expect(asked).toEqual([
      { task: 'digest-only', projectId: 'x' },
      { task: 'digest-only', projectId: 'x', fresh: true },
      { task: 'digest-only', projectId: 'x', fresh: true },
    ]);
  });

  it('offers to write a digest the project does not have yet', async () => {
    server(base({
      '/api/projects/x/cortex/instructions': () => Response.json({ instructions: [] }),
      '/api/projects/x/digests': () => Response.json({ digests: [] }),
    }));
    mount('/p/x/cortex?tab=digest');
    expect(await screen.findByRole('button', { name: /Regenerate digest/ })).toBeTruthy();
  });
});
