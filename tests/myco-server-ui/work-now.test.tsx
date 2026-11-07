/**
 * Myco's work now on the dashboard: the three parts drawn from the server's answer by one component, and the one live
 * refresh every page shares — the heartbeat read by the clock while the tab is in view and never while it is hidden,
 * the reads that follow a mark re-read only when it moves, and an unattended page that says so.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, focusManager, useQuery } from '@tanstack/react-query';
import { WorkNow } from '../../packages/myco-server/ui/src/features/now/WorkNow';
import type { WorkNowAnswer } from '../../packages/myco-server/ui/src/features/now/wire';
import { LiveRefresh } from '../../packages/myco-server/ui/src/hooks/use-live';
import { live, markPresence, PRESENCE_MS, RUNNING_TICK_MS, TICK_MS, UNATTENDED_HEADER, unattendedHeader } from '../../packages/myco-server/ui/src/lib/live';
import { fetchJson } from '../../packages/myco-server/ui/src/lib/api';

const NOW = Date.now();
const MYCO = 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11';

const ANSWER: WorkNowAnswer = {
  observedAt: NOW, scope: 'project', unavailable: [], marks: { runs: 'r1', sessions: 's1', fleet: 'f1' },
  running: [{ runId: 'run_live', projectId: MYCO, task: 'curate-spores', what: 'Curate overlapping spores', machine: 'homelab-mini',
    harness: 'claude-code', model: 'claude-sonnet-4-5', startedAt: NOW - 130_000, step: { words: 'Read a spore', at: NOW - 5_000 } }],
  waiting: [
    { key: 'learning', projectId: null, what: 'Learning from sessions', count: 3, why: 'Waiting for a runner that can sign in.', since: null, nextAt: null },
    { key: `curation:${MYCO}`, projectId: MYCO, what: 'Curation', count: null, why: 'Paused: 10 of 10 curation runs in the last 24 hours. The next starts as the earliest leaves that window.', since: null, nextAt: NOW + 2 * 3_600_000 },
  ],
  needsYou: [{ key: `curation-group:${MYCO}:k`, projectId: MYCO, what: 'A curation group failed twice', why: 'agent_line was 171 characters; the limit is 158.',
    at: NOW, runId: 'run_failed', retryAt: NOW + 3_600_000 }],
};

const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; globalThis.setInterval = originalSetInterval; focusManager.setFocused(undefined); markPresence(); });

function wrap(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
}

describe('Myco’s work now', () => {
  it('draws running, waiting and needs you from the server’s own words', () => {
    render(<WorkNow answer={ANSWER} pending={false} error={null} onRetry={() => {}} now={NOW} projectName={() => 'Myco'} />, { wrapper: wrap(new QueryClient()) });
    const running = screen.getByText('Curate overlapping spores').closest('a')!;
    expect(running.getAttribute('href')).toBe(`/p/${MYCO}/work/runs/run_live`);
    expect(within(running).getByText('Now: Read a spore')).toBeTruthy();
    expect(within(running).getByText(/homelab-mini · /)).toBeTruthy();
    expect(within(running).getByText('2m 10s')).toBeTruthy();
    const waiting = document.querySelector('[data-now-part="waiting"]') as HTMLElement;
    expect(within(waiting).getByText('Learning from sessions (3)')).toBeTruthy();
    expect(within(waiting).getByText(ANSWER.waiting[1]!.why)).toBeTruthy();
    expect(within(waiting).getByText('due in 2h')).toBeTruthy();
    const need = screen.getByText('A curation group failed twice').closest('a')!;
    expect(need.getAttribute('href')).toBe(`/p/${MYCO}/work/runs/run_failed`);
    expect(within(need).getByText(/^agent_line was 171 characters; the limit is 158\. Myco tries again at /)).toBeTruthy();
  });

  it('folds the same wait in several projects into one row naming them', () => {
    const map = (projectId: string) => ({ key: `map:${projectId}`, projectId, what: 'Code map', count: null, why: 'Due now. It starts when the server next checks.', since: null, nextAt: null });
    render(<WorkNow answer={{ ...ANSWER, scope: 'deployment', waiting: [map('a'), map('b'), ANSWER.waiting[1]!] }} pending={false} error={null} onRetry={() => {}} now={NOW}
      projectName={(id) => ({ a: 'Atlas', b: 'Ledger', [MYCO]: 'Myco' } as Record<string, string>)[id] ?? null} />, { wrapper: wrap(new QueryClient()) });
    const waiting = document.querySelector('[data-now-part="waiting"]') as HTMLElement;
    expect(within(waiting).getAllByText('Code map')).toHaveLength(1);
    expect(within(waiting).getByText('Atlas, Ledger')).toBeTruthy();
    expect(within(waiting).getByText('Myco')).toBeTruthy();
  });

  it('says each part is empty, and names a part the server could not read without hiding the others', () => {
    render(<WorkNow answer={{ ...ANSWER, running: [], needsYou: [], unavailable: ['needsYou'] }} pending={false} error={null} onRetry={() => {}} now={NOW} projectName={() => null} />, { wrapper: wrap(new QueryClient()) });
    expect(screen.getByText('Nothing is running right now.')).toBeTruthy();
    expect(within(document.querySelector('[data-now-part="needsYou"]') as HTMLElement).queryByText('Nothing needs you.')).toBeNull();
    expect(screen.getByText('Curation')).toBeTruthy();
  });
});

describe('the shared live refresh', () => {
  it('reads the heartbeat by the clock only while the tab is in view, faster while something runs', async () => {
    globalThis.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
      originalSetInterval(handler, ms === TICK_MS || ms === RUNNING_TICK_MS ? 15 : ms, ...args)) as typeof setInterval;
    let beats = 0;
    globalThis.fetch = (async () => { beats += 1; return Response.json({ ...ANSWER, running: [] }); }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<LiveRefresh projectId={MYCO} />, { wrapper: wrap(client) });
    await waitFor(() => expect(beats).toBeGreaterThanOrEqual(3));
    const options = client.getQueryCache().find({ queryKey: ['work-now', MYCO] })!;
    const interval = (options.observers[0]!.options as { refetchInterval: (q: unknown) => number }).refetchInterval;
    expect(interval({ state: { data: ANSWER } })).toBe(RUNNING_TICK_MS);
    expect(interval({ state: { data: { ...ANSWER, running: [] } } })).toBe(TICK_MS);

    act(() => focusManager.setFocused(false));
    const hidden = beats;
    await Bun.sleep(90);
    expect(beats).toBe(hidden);
    act(() => focusManager.setFocused(true));
    await waitFor(() => expect(beats).toBeGreaterThan(hidden));
  });

  it('re-reads only the open reads that follow a mark that moved', async () => {
    globalThis.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
      originalSetInterval(handler, ms === TICK_MS || ms === RUNNING_TICK_MS ? 20 : ms, ...args)) as typeof setInterval;
    let beat = 0;
    const asked: Record<string, number> = {};
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'https://s').pathname;
      asked[path] = (asked[path] ?? 0) + 1;
      if (path === '/api/work/now') { beat += 1; return Response.json({ ...ANSWER, marks: { ...ANSWER.marks, runs: beat >= 2 ? 'r2' : 'r1' } }); }
      return Response.json({});
    }) as unknown as typeof fetch;
    function Follower({ path, follows }: { path: string; follows: 'runs' | 'sessions' }) {
      useQuery({ queryKey: [path], queryFn: ({ signal }) => fetchJson(path, signal), ...live({ follows: [follows] }) });
      return null;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(<><LiveRefresh projectId={MYCO} /><Follower path="/api/work" follows="runs" /><Follower path="/api/sessions" follows="sessions" /></>, { wrapper: wrap(client) });
    await waitFor(() => expect(beat).toBeGreaterThanOrEqual(4));
    expect(asked['/api/work']).toBe(2);
    expect(asked['/api/sessions']).toBe(1);
  });

  it('marks a read made with no one at the dashboard, so it never counts as someone using the server', () => {
    markPresence(NOW);
    expect(unattendedHeader(NOW + PRESENCE_MS - 1)).toEqual({});
    expect(unattendedHeader(NOW + PRESENCE_MS + 1)).toEqual({ [UNATTENDED_HEADER]: '1' });
  });
});
