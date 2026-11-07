/**
 * Myco's work now on the dashboard: the three parts drawn from the server's answer by one component, and the one live
 * refresh every page shares — the heartbeat read by the clock while the tab is in view and never while it is hidden,
 * the reads that follow a mark re-read only when it moves or their answer goes stale by time, and fetch traffic
 * kept apart from a person's presence.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, focusManager, useQuery } from '@tanstack/react-query';
import { WorkNow } from '../../packages/myco-server/ui/src/features/now/WorkNow';
import type { WorkNowAnswer } from '../../packages/myco-server/ui/src/features/now/wire';
import { LiveRefresh } from '../../packages/myco-server/ui/src/hooks/use-live';
import { AUTOMATIC_HEADER, live, PRESENCE_MS, PRESENCE_PATH, RUNNING_TICK_MS, TICK_MS, watchPresence } from '../../packages/myco-server/ui/src/lib/live';
import { liveUntil } from '../../packages/myco-server/ui/src/hooks/use-sessions';
import { LIVE_WITHIN_MS } from '../../packages/myco-server/ui/src/features/today/timeline';
import { fetchJson } from '../../packages/myco-server/ui/src/lib/api';

const NOW = Date.now();
const MYCO = 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11';

const ANSWER: WorkNowAnswer = {
  observedAt: NOW, scope: 'project', unavailable: [], marks: { runs: 'r1', sessions: 's1', knowledge: 'k1', recovery: 'b1', fleet: 'f1' }, projects: { read: 1, total: 1, hasMore: false, cursor: null }, runningTotal: 1, runningHasMore: false,
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
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; globalThis.setInterval = originalSetInterval; focusManager.setFocused(undefined); });

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

  it('shows the exact running total when the running page has more work', () => {
    render(<WorkNow answer={{ ...ANSWER, runningTotal: 23, runningHasMore: true }} pending={false} error={null}
      onRetry={() => {}} now={NOW} projectName={() => null} />, { wrapper: wrap(new QueryClient()) });
    expect(screen.getByText('Showing 1 of 23 running runs. Open a project to see its work.')).toBeTruthy();
  });

  it('folds the same wait in several projects into one row naming them', () => {
    const map = (projectId: string) => ({ key: `map:${projectId}`, projectId, what: 'Code map', count: null, why: 'Due now. It starts when the server next checks.', since: null, nextAt: null });
    render(<WorkNow answer={{ ...ANSWER, scope: 'deployment', waiting: [map('a'), map('b'), ANSWER.waiting[1]!] }} pending={false} error={null} onRetry={() => {}} now={NOW}
      projectName={(id) => ({ a: 'Atlas', b: 'Ledger', [MYCO]: 'Myco' } as Record<string, string>)[id] ?? null} />, { wrapper: wrap(new QueryClient()) });
    const waiting = document.querySelector('[data-now-part="waiting"]') as HTMLElement;
    expect(within(waiting).getAllByText('Code map')).toHaveLength(1);
    const names = waiting.querySelector('[data-chip-group]:has(> :nth-child(2))') as HTMLElement;
    expect([...names.children].map((chip) => chip.textContent)).toEqual(['Atlas', 'Ledger']);
    expect(names.className).toContain('flex-wrap');
    expect(within(waiting).getByText('Myco')).toBeTruthy();
  });

  it('says each part is empty, and names a part the server could not read without hiding the others', () => {
    render(<WorkNow answer={{ ...ANSWER, running: [], runningTotal: 0, needsYou: [], unavailable: ['needsYou'] }} pending={false} error={null} onRetry={() => {}} now={NOW} projectName={() => null} />, { wrapper: wrap(new QueryClient()) });
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
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (new URL(String(input), 'https://s').pathname === '/api/work/now') beats += 1;
      return Response.json({ ...ANSWER, running: [] });
    }) as unknown as typeof fetch;
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
      if (path === '/api/work/now') { beat += 1; return Response.json({ ...ANSWER, marks: { ...ANSWER.marks, runs: beat >= 2 ? 'r2' : 'r1', knowledge: beat >= 3 ? 'k2' : 'k1' } }); }
      return Response.json({});
    }) as unknown as typeof fetch;
    function Follower({ path, follows }: { path: string; follows: 'runs' | 'sessions' | 'knowledge' }) {
      useQuery({ queryKey: [path], queryFn: ({ signal }) => fetchJson(path, signal), ...live({ follows: [follows] }) });
      return null;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(<><LiveRefresh projectId={MYCO} /><Follower path="/api/work" follows="runs" /><Follower path="/api/sessions" follows="sessions" /><Follower path="/api/spores" follows="knowledge" /></>, { wrapper: wrap(client) });
    await waitFor(() => expect(beat).toBeGreaterThanOrEqual(4));
    expect(asked['/api/work']).toBe(2);
    expect(asked['/api/sessions']).toBe(1);
    expect(asked['/api/spores']).toBe(2);
  });

  it('reads a live group again when its first session falls quiet, though nothing was captured', () => {
    const page = { rows: [{ lastReceivedAt: NOW - 60_000 }, { lastReceivedAt: NOW - 600_000 }], cursor: null } as unknown as Parameters<typeof liveUntil>[0];
    expect(liveUntil(page)).toBe(NOW - 600_000 + LIVE_WITHIN_MS);
    expect(liveUntil({ rows: [], cursor: null } as unknown as Parameters<typeof liveUntil>[0])).toBeNull();
    const options = live<typeof page>({ follows: ['sessions'], until: liveUntil }) as { refetchInterval: (q: unknown) => number | false; refetchIntervalInBackground: boolean; meta: unknown };
    const wait = options.refetchInterval({ state: { data: page } });
    expect(typeof wait === 'number' && wait > 0 && wait <= LIVE_WITHIN_MS).toBe(true);
    expect(options.refetchInterval({ state: { data: { rows: [], cursor: null } } })).toBe(false);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.meta).toEqual({ follows: ['sessions'] });
  });

  it('says how many projects it read when it could not read them all, and where the rest are', () => {
    render(<WorkNow answer={{ ...ANSWER, scope: 'deployment', projects: { read: 25, total: 40, hasMore: true, cursor: { priority: 0, activity: 1, projectId: 'p' } } }} pending={false} error={null} onRetry={() => {}} now={NOW} projectName={() => 'Myco'} />, { wrapper: wrap(new QueryClient()) });
    const more = document.querySelector('[data-now-more]') as HTMLElement;
    expect(more.textContent).toBe('Checked 25 of 40 projects: those with unresolved failures or live work first, then most recently active. Open a project to see the rest.');
    expect(within(more).getByRole('link', { name: 'Open a project' }).getAttribute('href')).toBe('/projects');
  });

  it('marks every read the dashboard makes as automatic, and reports a person only on their own use of the page', async () => {
    const headers: Array<Record<string, string>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { headers.push({ ...(init?.headers as Record<string, string>) }); return Response.json({}); }) as unknown as typeof fetch;
    await fetchJson('/api/work/now');
    expect(headers[0]).toMatchObject({ [AUTOMATIC_HEADER]: '1' });

    let clock = NOW;
    let reports = 0;
    const stop = watchPresence(() => { reports += 1; }, window, () => clock);
    expect(reports).toBe(1);
    window.dispatchEvent(new Event('pointerdown'));
    expect(reports).toBe(1);
    clock += PRESENCE_MS;
    window.dispatchEvent(new Event('keydown'));
    expect(reports).toBe(2);
    clock += PRESENCE_MS * 10;
    expect(reports).toBe(2);
    stop();
    expect(PRESENCE_PATH).toBe('/api/presence');
  });
});
