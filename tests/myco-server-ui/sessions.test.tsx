import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { promptPreview, PROMPT_PREVIEW_CHARS } from '../../packages/myco-server/ui/src/components/sessions/TurnCard';
import { parseChecklist } from '../../packages/myco-server/ui/src/components/sessions/PlanCard';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris' } };
const PROJECTS = { projects: [{ projectId: 'x', name: 'Project X', createdAt: 0, sessionCount: 2, lastActivityAt: null }] };
const NOW = Date.now();
const KEY_TEXT = 'a'.repeat(64);
const KEY_IMG = 'b'.repeat(64);
const KEY_SVG = 'c'.repeat(64);
const KEY_SEG = 'd'.repeat(64);
const BLOB = (key: string) => `/api/projects/x/blobs/${key}`;
const P1 = '00000000-0000-7000-8000-000000000001';
const P2 = '00000000-0000-7000-8000-000000000002';
const P3 = '00000000-0000-7000-8000-000000000003';

const session = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1', machineId: 'mac-1', createdByTokenId: 'tok_1', firstReceivedAt: NOW - 3_600_000, lastReceivedAt: NOW - 60_000,
  agent: 'claude-code', branch: 'main', startedAt: NOW - 3_600_000, endedAt: null, originPath: '/repo', parentSessionId: null, parentReason: null,
  memberId: 'mem_1', memberLabel: 'chris', runtimeLabel: 'laptop', runtimeKind: 'host',
  title: null, summary: null, titledAt: null, label: (over.title as string | undefined) ?? (over.label as string | undefined) ?? (over.agent as string | undefined) ?? 'claude-code',
  promptCount: 2, toolCallCount: 3, activityBuckets: [1, 0, 0, 1, 0, 0, 0, 0], ...over,
});
const page = (rows: unknown[]) => Response.json({ rows, cursor: null });
const counts = { prompts: 2, toolCalls: 3, responses: 1, plans: 0, attachments: 2 };

const turn = (over: Record<string, unknown> = {}) => ({
  promptId: P1, origin: 'user', promptKind: null, threadLabel: null, preview: 'Please rename the project card', textChars: 30, blobKey: null,
  createdAt: NOW - 3000, toolCallCount: 1, responseCount: 1, childCount: 0, ...over,
});

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(routes: Record<string, () => Response>): { requested: string[] } {
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    requested.push(url.pathname + url.search);
    return routes[url.pathname + url.search]?.() ?? routes[url.pathname]?.() ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { requested };
}

const base = (extra: Record<string, () => Response> = {}) => ({
  '/auth/me': () => Response.json(ME),
  '/api/projects': () => Response.json(PROJECTS),
  ...extra,
});

/** Where the router is, readable from a test. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /><LocationProbe /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

/** A wide screen for the duration of `fn`; the shim answers narrow otherwise. */
async function onWideScreen(fn: () => Promise<void>): Promise<void> {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query.includes('min-width'), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  try { await fn(); } finally { window.matchMedia = original; }
}

const ACTIVITY = { items: [], stats: { sessions: 12, openSessions: 1, sessionsLast7d: 4, prompts: 340, toolCalls: 900, plans: 0, attachments: 3, lastActivityAt: NOW } };

describe('Sessions list', () => {
  const ROWS = [
    session({ title: 'Wave-based executor', label: 'Wave-based executor', promptCount: 12, toolCallCount: 40, activityBuckets: [3, 0, 0, 2, 0, 0, 4, 3] }),
    session({ sessionId: 's2', agent: 'codex', branch: 'fix', startedAt: NOW - 2 * 3_600_000, endedAt: NOW - 1000, memberLabel: null, memberId: null, runtimeLabel: null, label: 'Fix the flaky test…', promptCount: 3, toolCallCount: 7 }),
    session({ sessionId: 's3', agent: 'codex', branch: null, startedAt: NOW - 3 * 24 * 3_600_000, endedAt: NOW - 2 * 24 * 3_600_000, label: 'An older one', promptCount: 1, toolCallCount: 0 }),
  ];

  it('sections the rail — open first, then today and earlier — with the project\'s counts on top, each card carrying its agent, counts, activity and branch', async () => {
    server(base({ '/api/projects/x/sessions?limit=50': () => page(ROWS), '/api/projects/x/activity': () => Response.json(ACTIVITY) }));
    mount('/p/x/sessions');
    const rows = await screen.findAllByRole('row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Wave-based executor'),
      expect.stringContaining('Fix the flaky test…'),
      expect.stringContaining('An older one'),
    ]);
    expect(screen.getAllByRole('separator').map((s) => s.textContent)).toEqual(['OPEN1', 'TODAY1', 'EARLIER1']);
    expect(rows[0]!.textContent).toContain('claude-code · 12p · 40t');
    expect(rows[1]!.textContent).toContain('codex · 3p · 7t');
    expect(rows[1]!.textContent).toContain('fix');
    expect(within(rows[0]!).getByRole('img', { name: /12 prompts across this session/ })).toBeTruthy();
    expect(rows[1]!.textContent).toContain('ended ');
    expect(rows[0]!.textContent).toContain('last ');
    expect((await screen.findByTestId('rail-counts')).textContent).toBe('12 TOTAL·1 OPEN·340 PROMPTS');
  });

  it('asks the server to filter, by state from the tabs and by text from the box, and says so when nothing matches', async () => {
    const { requested } = server(base({
      '/api/projects/x/sessions?limit=50': () => page(ROWS),
      '/api/projects/x/sessions?limit=50&state=ended': () => page(ROWS.slice(1)),
      '/api/projects/x/sessions?limit=50&q=fix': () => page([ROWS[1]]),
      '/api/projects/x/sessions?limit=50&q=nothing-here': () => page([]),
      '/api/projects/x/activity': () => Response.json(ACTIVITY),
    }));
    mount('/p/x/sessions');
    await screen.findAllByRole('row');
    fireEvent.click(screen.getByRole('tab', { name: 'Ended' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
    expect(screen.getByTestId('rail-counts').textContent).toBe('2 SHOWN');
    expect(screen.getByTestId('location').textContent).toBe('/p/x/sessions?state=ended');
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    // Three keystrokes inside the debounce make one read, for the text as it stands when the typing pauses.
    const box = screen.getByLabelText('Filter sessions');
    fireEvent.change(box, { target: { value: 'f' } });
    fireEvent.change(box, { target: { value: 'fi' } });
    fireEvent.change(box, { target: { value: 'fix' } });
    await waitFor(() => expect(screen.getAllByRole('row').map((r) => r.textContent)).toEqual([expect.stringContaining('codex')]));
    fireEvent.change(box, { target: { value: 'nothing-here' } });
    expect(await screen.findByText('No sessions match.')).toBeTruthy();
    expect(screen.getByTestId('rail-counts').textContent).toBe('0 SHOWN');
    expect(requested.filter((p) => p.startsWith('/api/projects/x/sessions?'))).toEqual([
      '/api/projects/x/sessions?limit=50',
      '/api/projects/x/sessions?limit=50&state=ended',
      '/api/projects/x/sessions?limit=50',
      '/api/projects/x/sessions?limit=50&q=fix',
      '/api/projects/x/sessions?limit=50&q=nothing-here',
    ]);
  });

  it('adopts a filter that arrives from a link rather than overwriting it, and keeps the filter on the link to a session', async () => {
    server(base({
      '/api/projects/x/sessions?limit=50&q=fix': () => page([ROWS[1]]),
      '/api/projects/x/sessions/s2': () => Response.json({ session: ROWS[1], counts, projectId: 'x' }),
      '/api/projects/x/sessions/s2/turns?origins=user&limit=200': () => page([]),
      '/api/projects/x/activity': () => Response.json(ACTIVITY),
    }));
    mount('/p/x/sessions?q=fix');
    const rows = await screen.findAllByRole('row');
    expect((screen.getByLabelText('Filter sessions') as HTMLInputElement).value).toBe('fix');
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByTestId('location').textContent).toBe('/p/x/sessions?q=fix');
    fireEvent.click(rows[0]!);
    expect(await screen.findByRole('heading', { level: 2 })).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe('/p/x/sessions/s2?q=fix');
  });

  it('opens the first row on its own on a wide screen when nothing is selected, and never under a narrowed list', async () => {
    await onWideScreen(async () => {
      for (const narrowed of ['?state=ended', '?q=fix']) {
        server(base({
          '/api/projects/x/sessions?limit=50&state=ended': () => page(ROWS.slice(1)),
          '/api/projects/x/sessions?limit=50&q=fix': () => page([ROWS[1]]),
          '/api/projects/x/activity': () => Response.json(ACTIVITY),
        }));
        mount(`/p/x/sessions${narrowed}`);
        await screen.findAllByRole('row');
        expect(screen.getByText('Select a session to read it.')).toBeTruthy();
        expect(screen.getByTestId('location').textContent).toBe(`/p/x/sessions${narrowed}`);
        cleanup();
      }
      server(base({
        '/api/projects/x/sessions?limit=50': () => page(ROWS),
        '/api/projects/x/sessions/s1': () => Response.json({ session: ROWS[0], counts, projectId: 'x' }),
        '/api/projects/x/sessions/s1/turns?origins=user&limit=200': () => page([]),
        '/api/projects/x/activity': () => Response.json(ACTIVITY),
      }));
      mount('/p/x/sessions');
      expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe('Wave-based executor');
      expect(screen.getAllByRole('row')[0]!.getAttribute('data-selected')).toBe('true');
      expect(screen.getByTestId('location').textContent).toBe('/p/x/sessions/s1');
    });
  });

  it('moves a cursor with the keyboard, follows a selection made by pointer, opens the row under it once, and jumps to the filter on slash', async () => onWideScreen(async () => {
    server(base({
      '/api/projects/x/sessions?limit=50': () => page(ROWS),
      '/api/projects/x/sessions/s1': () => Response.json({ session: ROWS[0], counts, projectId: 'x' }),
      '/api/projects/x/sessions/s1/turns?origins=user&limit=200': () => page([]),
      '/api/projects/x/sessions/s2': () => Response.json({ session: ROWS[1], counts, projectId: 'x' }),
      '/api/projects/x/sessions/s2/turns?origins=user&limit=200': () => page([]),
      '/api/projects/x/sessions/s3': () => Response.json({ session: ROWS[2], counts, projectId: 'x' }),
      '/api/projects/x/sessions/s3/turns?origins=user&limit=200': () => page([]),
      '/api/projects/x/activity': () => Response.json(ACTIVITY),
    }));
    mount('/p/x/sessions');
    let rows = await screen.findAllByRole('row');
    // The wide screen opens the first row on its own; the cursor starts there.
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Wave-based executor'));
    const table = screen.getByRole('table', { name: 'Sessions' });
    fireEvent.keyDown(table, { key: 'j' });
    expect(screen.getAllByRole('row')[1]!.getAttribute('data-cursor')).toBe('true');
    fireEvent.keyDown(table, { key: 'Enter' });
    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe('Fix the flaky test…');
    // A pointer selection moves the cursor with it; the next k steps up from there.
    rows = screen.getAllByRole('row');
    fireEvent.click(rows[2]!);
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('An older one'));
    fireEvent.keyDown(table, { key: 'k' });
    expect(screen.getAllByRole('row')[1]!.getAttribute('data-cursor')).toBe('true');
    // Enter on a focused row opens that row once: the row's own handler, not the container's too.
    rows[1]!.focus();
    fireEvent.keyDown(rows[1]!, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Fix the flaky test…'));
    expect(screen.getByTestId('location').textContent).toBe('/p/x/sessions/s2');
    fireEvent.keyDown(table, { key: '/' });
    expect(document.activeElement).toBe(screen.getByLabelText('Filter sessions'));
  }));

  it('shows a project with no sessions as empty, not missing', async () => {
    server(base({ '/api/projects/x/sessions?limit=50': () => page([]), '/api/projects/x/activity': () => Response.json(ACTIVITY) }));
    mount('/p/x/sessions');
    expect(await screen.findByText(/No sessions yet/)).toBeTruthy();
  });
});

describe('Session detail', () => {
  const detailRoutes = (over: Record<string, () => Response> = {}) => base({
    '/api/projects/x/sessions': () => page([session()]),
    '/api/projects/x/sessions/s1': () => Response.json({ session: session(), counts, projectId: 'x' }),
    '/api/projects/x/sessions/s1/turns?origins=user&limit=200': () => page([
      turn({ promptId: P1, preview: `Please rename the project card ${'x'.repeat(130)}`, textChars: 30_000, toolCallCount: 1, responseCount: 1 }),
      turn({ promptId: P3, preview: null, textChars: null, blobKey: KEY_TEXT, toolCallCount: 2, responseCount: 0, childCount: 1, createdAt: NOW - 1000 }),
    ]),
    '/api/projects/x/sessions/s1/turns?origins=agent_dispatch%2Chook_injected%2Csystem%2Cunknown%2Cuser&limit=200': () => page([
      turn({ promptId: P1, preview: 'Please rename the project card', toolCallCount: 1, responseCount: 1 }),
      turn({ promptId: P2, origin: 'system', preview: '<system-reminder>injected</system-reminder>', textChars: 40, toolCallCount: 0, responseCount: 0, createdAt: NOW - 2000 }),
      turn({ promptId: P3, preview: null, textChars: null, blobKey: KEY_TEXT, toolCallCount: 2, responseCount: 0, childCount: 1, createdAt: NOW - 1000 }),
    ]),
    [`/api/projects/x/sessions/s1/turns/${P1}`]: () => Response.json({
      prompt: { promptId: P1, origin: 'user', promptKind: null, parentPromptId: null, threadLabel: null, text: `Please rename the project card ${'x'.repeat(130)}\n\nAnd the rest of a long prompt.`, blobKey: null, createdAt: NOW - 3000 },
      responses: [{ responseId: 'r1', promptId: P1, text: 'done', blobKey: null, createdAt: NOW - 1000, orderedAt: NOW - 1000 }],
      attachments: [{ attachmentId: 'a1', promptId: P1, blobKey: KEY_IMG, mediaType: 'image/png', byteSize: 1234, description: 'a screenshot', createdAt: NOW, orderedAt: NOW }],
      children: [],
    }),
    [`/api/projects/x/sessions/s1/turns/${P3}`]: () => Response.json({
      prompt: { promptId: P3, origin: 'user', promptKind: null, parentPromptId: null, threadLabel: null, text: null, blobKey: KEY_TEXT, createdAt: NOW - 1000 },
      responses: [],
      attachments: [],
      children: [{ prompt: { promptId: P2, origin: 'user', promptKind: null, parentPromptId: P3, threadLabel: 'reviewer', text: 'steer it left', blobKey: null, createdAt: NOW - 900 }, responses: [{ responseId: 'r2', promptId: P2, text: 'steered', blobKey: null, createdAt: NOW - 800, orderedAt: NOW - 800 }], toolCallCount: 0 }],
    }),
    [`/api/projects/x/sessions/s1/turns/${P1}/tool-calls?limit=200`]: () => page([
      { toolCallId: 't1', promptId: P1, toolName: 'Write', mycoTool: null, mycoOp: null, inputPreview: 'x'.repeat(20), inputBytes: 190_000, inputBlobKey: null, outputPreview: 'wrote it', outputBlobKey: null, success: false, errorMessage: 'disk full', durationMs: 42, filesAffected: '["/repo/a.ts"]', createdAt: NOW - 2000, orderedAt: NOW - 2000 },
    ]),
    '/api/projects/x/sessions/s1/plans': () => page([]),
    '/api/projects/x/sessions/s1/attachments': () => page([
      { attachmentId: 'a1', promptId: P1, blobKey: KEY_IMG, mediaType: 'image/png', byteSize: 1234, description: 'a screenshot', createdAt: NOW, orderedAt: NOW },
      { attachmentId: 'a2', promptId: null, blobKey: KEY_SVG, mediaType: 'image/svg+xml', byteSize: 99, description: 'a diagram', createdAt: NOW, orderedAt: NOW },
    ]),
    '/api/projects/x/sessions/s1/transcript': () => Response.json({
      transcript: { transcriptId: 'tx1', sessionId: 's1', machineId: 'mac-1', agent: 'claude-code', originPath: '/repo', size: 7_340_032, segmentCount: 2, firstReceivedAt: NOW - 3000, lastReceivedAt: NOW },
      segments: [{ baseOffset: 0, length: 4_000_000, blobKey: KEY_SEG, createdAt: NOW - 3000 }, { baseOffset: 4_000_000, length: 3_340_032, blobKey: KEY_SEG, createdAt: NOW }],
    }),
    [BLOB(KEY_TEXT)]: () => new Response('{"a":1}', { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    ...over,
  });

  it('renders the turns a person typed, collapsed but the last, and reads a turn\'s body — and its stored text — only when it opens', async () => {
    const { requested } = server(detailRoutes());
    mount('/p/x/sessions/s1');
    const first = await screen.findByTestId(`turn-${P1}`);
    // A collapsed card carries the preview cut at the preview length and nothing of the 30 K-char prompt.
    const collapsed = within(first).getByRole('button', { expanded: false }).textContent ?? '';
    expect(collapsed).toContain(`Please rename the project card ${'x'.repeat(120 - 'Please rename the project card '.length)}…`);
    expect(collapsed).not.toContain('x'.repeat(100));
    expect(collapsed).not.toContain('And the rest');
    expect(first.textContent).toContain('1 tool call');
    expect(screen.getAllByTestId(/^turn-0000/).map((el) => el.getAttribute('data-testid'))).toEqual([`turn-${P1}`, `turn-${P3}`]);
    expect(screen.queryByTestId(`turn-${P2}`)).toBeNull();
    // The last turn opens on its own; its stored text is fetched then, not for the collapsed one.
    const last = screen.getByTestId(`turn-${P3}`);
    expect(await within(last).findByText('{"a":1}')).toBeTruthy();
    expect(within(last).getByTestId('turn-child').textContent).toContain('steer it left');
    expect(within(last).getByTestId('turn-child').textContent).toContain('reviewer');
    expect(within(last).getByTestId('turn-child').textContent).toContain('steered');
    expect(within(first).queryByTestId('turn-body')).toBeNull();
    expect(requested.filter((p) => p.includes('/turns/'))).toEqual([`/api/projects/x/sessions/s1/turns/${P3}`]);
    expect(requested.filter((p) => p.startsWith('/api/projects/x/blobs/'))).toEqual([BLOB(KEY_TEXT)]);
    // Opening the first turn reads its body: the prompt in full, its response, and its screenshot under it.
    fireEvent.click(within(first).getByRole('button', { expanded: false }));
    expect(await within(first).findByTestId('turn-body')).toBeTruthy();
    expect(within(first).getByTestId('turn-body').textContent).toContain('And the rest of a long prompt.');
    expect(within(first).getByTestId('turn-response').textContent).toContain('done');
    const img = within(first).getByRole('img', { name: 'a screenshot' });
    expect(img.getAttribute('src')).toBe(BLOB(KEY_IMG));
    expect(screen.getAllByText('chris').length).toBeGreaterThan(0);
    expect(screen.getByText('laptop · mac-1')).toBeTruthy();
  });

  it('reads a turn\'s tool calls only when their toggle opens, then shows how each went', async () => {
    const { requested } = server(detailRoutes());
    mount('/p/x/sessions/s1');
    const first = await screen.findByTestId(`turn-${P1}`);
    fireEvent.click(within(first).getByRole('button', { expanded: false }));
    const toggle = await within(first).findByTestId('tool-calls-toggle');
    expect(requested.some((p) => p.includes('/tool-calls'))).toBe(false);
    fireEvent.click(toggle);
    const row = await within(first).findByTestId('tool-call-t1');
    expect(row.textContent).toContain('Write');
    expect(row.textContent).toContain('/repo/a.ts');
    expect(row.textContent).toContain('42ms');
    expect(within(row).queryByText('disk full')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    expect(within(row).getByText('disk full')).toBeTruthy();
    expect(within(row).getByText('wrote it')).toBeTruthy();
    expect(within(row).getByText(/Input · 186 KB/)).toBeTruthy();
  });

  it('shows every injected prompt on request, in its own list, and still opens the last turn a person typed', async () => {
    const { requested } = server(detailRoutes());
    mount('/p/x/sessions/s1');
    await screen.findByTestId(`turn-${P1}`);
    fireEvent.click(screen.getByLabelText(/Show system/));
    const injected = await screen.findByTestId(`turn-${P2}`);
    expect(injected.getAttribute('data-origin')).toBe('system');
    expect(injected.textContent).toContain('System');
    expect(within(injected).getByRole('button', { expanded: false })).toBeTruthy();
    expect(within(screen.getByTestId(`turn-${P3}`)).getByRole('button', { expanded: true })).toBeTruthy();
    expect(requested.filter((p) => p.includes('/turns?')).length).toBe(2);
  });

  it('says what an empty person-typed list means when the session holds only injected prompts', async () => {
    server(detailRoutes({ '/api/projects/x/sessions/s1/turns?origins=user&limit=200': () => page([]) }));
    mount('/p/x/sessions/s1');
    expect(await screen.findByText(/No prompts typed by a person/)).toBeTruthy();
  });

  it('heads the detail with the label and shows a summary only once one is stored', async () => {
    server(detailRoutes());
    mount('/p/x/sessions/s1');
    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe('claude-code');
    expect(screen.queryByText('Summary')).toBeNull();
    cleanup();
    server(detailRoutes({ '/api/projects/x/sessions/s1': () => Response.json({ session: session({ title: 'Wave-based executor', summary: 'Built the executor.\nTests pass.', titledAt: NOW }), counts, projectId: 'x' }) }));
    mount('/p/x/sessions/s1');
    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe('Wave-based executor');
    expect(screen.getByText('Summary')).toBeTruthy();
    expect(screen.getByText(/Built the executor\./).textContent).toBe('Built the executor.\nTests pass.');
  });

  it('renders an image attachment inline only for the renderable types, and links the rest', async () => {
    server(detailRoutes());
    mount('/p/x/sessions/s1?tab=attachments');
    const img = await screen.findByRole('img', { name: 'a screenshot' });
    expect(img.getAttribute('src')).toBe(BLOB(KEY_IMG));
    expect(screen.queryByRole('img', { name: 'a diagram' })).toBeNull();
    expect(screen.getByText('Download a diagram').getAttribute('href')).toBe(BLOB(KEY_SVG));
  });

  it('lists captured plans as cards with their status, key and checklist progress', async () => {
    server(detailRoutes({ '/api/projects/x/sessions/s1/plans': () => page([
      { planKey: 'plan-1', title: 'Ship the thing', status: 'in_progress', content: '# Plan\n- [x] one\n- [ ] two', blobKey: null, createdAt: NOW - 5000, updatedAt: NOW - 1000, orderedAt: NOW - 1000 },
    ]) }));
    mount('/p/x/sessions/s1?tab=plans');
    const card = await screen.findByTestId('plan-plan-1');
    expect(card.textContent).toContain('in progress');
    expect(card.textContent).toContain('Ship the thing');
    expect(card.textContent).toContain('1/2 items');
    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe('Plan');
    expect(within(card).queryByRole('heading', { level: 1 })).toBeNull();
    expect(parseChecklist('- [x] a\n- [ ] b\n- [X] c')).toEqual({ total: 3, checked: 2 });
  });

  it('links the transcript by segment and never fetches its bytes', async () => {
    const { requested } = server(detailRoutes());
    mount('/p/x/sessions/s1');
    fireEvent.click(await screen.findByRole('tab', { name: 'Transcript' }));
    expect(await screen.findByText(/7\.0 MB · 2 segments/)).toBeTruthy();
    const links = screen.getAllByRole('link', { name: /^bytes / });
    expect(links.map((a) => a.getAttribute('href'))).toEqual([BLOB(KEY_SEG), BLOB(KEY_SEG)]);
    expect(requested).not.toContain(BLOB(KEY_SEG));
  });

  it('answers a session the server does not hold with not found, never forbidden', async () => {
    server(base({ '/api/projects/x/sessions': () => page([]) }));
    mount('/p/x/sessions/gone');
    expect(await screen.findByText(/not found/i)).toBeTruthy();
    expect(screen.queryByText(/forbidden/i)).toBeNull();
  });

  it('cuts a collapsed preview at the preview length and names stored text by its size', () => {
    expect(promptPreview({ preview: 'short', textChars: 5, blobKey: null })).toBe('short');
    expect(promptPreview({ preview: 'x'.repeat(160), textChars: 400, blobKey: null })).toBe(`${'x'.repeat(PROMPT_PREVIEW_CHARS)}…`);
    expect(promptPreview({ preview: 'line one\n\nline   two', textChars: 19, blobKey: null })).toBe('line one line two');
    expect(promptPreview({ preview: null, textChars: null, blobKey: KEY_TEXT })).toBe('Stored text');
    expect(promptPreview({ preview: null, textChars: null, blobKey: null })).toBe('(no prompt)');
  });
});

describe('Project home', () => {
  it('shows what the project holds and the recent activity, each item linking where it belongs', async () => {
    server(base({
      '/api/projects/x/activity': () => Response.json({
        items: [
          { type: 'spore', id: 'sp1', summary: 'gotcha: a thing', at: NOW - 1000, sessionId: 's1' },
          { type: 'run', id: 'r1', summary: 'digest — completed', at: NOW - 2000, sessionId: null },
          { type: 'session', id: 's1', summary: 'claude-code on main', at: NOW - 3000, sessionId: 's1' },
        ],
        stats: { sessions: 2, openSessions: 1, sessionsLast7d: 2, prompts: 9, toolCalls: 40, plans: 1, attachments: 2, lastActivityAt: NOW - 1000 },
      }),
    }));
    mount('/p/x');
    expect(await screen.findByText('gotcha: a thing')).toBeTruthy();
    expect(screen.getByText('1 open')).toBeTruthy();
    expect(screen.getByText('40')).toBeTruthy();
    expect(screen.getByText('digest — completed').getAttribute('href')).toBe('/p/x/runs/r1');
    expect(screen.getByText('claude-code on main').getAttribute('href')).toBe('/p/x/sessions/s1');
    expect(screen.getByText('gotcha: a thing').getAttribute('href')).toBe('/p/x/sessions/s1');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Project X');
    expect(screen.getByTestId('activity-line').textContent).toBe('1 open session');
    expect(screen.getByTestId('capture-health').textContent).toBe('Capturing now');
  });

  it('composes the home in the 1.4 shape: the open sessions with their activity, recent runs running first, recently evolved skills', async () => {
    server(base({
      '/api/projects/x/activity': () => Response.json({ items: [], stats: { sessions: 3, openSessions: 1, sessionsLast7d: 3, prompts: 9, toolCalls: 40, plans: 0, attachments: 0, lastActivityAt: NOW - 1000 } }),
      '/api/projects/x/sessions?limit=50&state=open': () => page([session({ label: 'Wave-based executor', promptCount: 12, toolCallCount: 40, activityBuckets: [1, 2, 0, 0, 3, 0, 0, 1] })]),
      '/api/projects/x/runs?limit=50': () => page([
        { id: 'run-newer-completed', agentId: 'a', task: 'digest', status: 'completed', provider: null, model: 'm1', startedAt: NOW - 2000, resumedAt: null, completedAt: NOW - 1000, tokensUsed: 12_000, costUsd: null, costSource: null, dryRun: false, resumable: false, resumeStatus: null, failed: false },
        { id: 'run-older-running', agentId: 'a', task: 'title-summary', status: 'running', provider: null, model: null, startedAt: NOW - 20_000, resumedAt: null, completedAt: null, tokensUsed: null, costUsd: null, costSource: null, dryRun: true, resumable: false, resumeStatus: null, failed: false },
      ]),
      '/api/agents': () => Response.json({ agents: [{ id: 'a', name: 'Default', provider: 'anthropic', model: 'm', enabled: true }] }),
      '/api/projects/x/skills?limit=200': () => Response.json({ skills: [
        { id: 'sk1', agentId: 'a', name: 'ship-it', displayName: 'Ship it', description: 'd', status: 'active', generation: 3, sourceIds: '[]', usageCount: 2, lastUsedAt: null, createdAt: NOW - 5000, updatedAt: NOW - 1000 },
      ] }),
    }));
    mount('/p/x');
    const hero = await screen.findByRole('list', { name: 'Open sessions' });
    expect(hero.textContent).toContain('Wave-based executor');
    expect(hero.textContent).toContain('claude-code');
    expect(hero.textContent).toContain('12p · 40t');
    expect(within(hero).getByRole('img', { name: /7 prompts across this session/ })).toBeTruthy();
    expect(screen.getByTestId('activity-line').textContent).toBe('1 open session · 1 run running');
    const runs = within(screen.getByRole('list', { name: 'Recent runs' })).getAllByRole('listitem');
    expect(runs.map((r) => r.textContent)).toEqual([expect.stringContaining('title-summary'), expect.stringContaining('digest')]);
    expect(runs[0]!.textContent).toContain('dry');
    expect(runs[1]!.textContent).toContain('12.0k tok');
    const skills = within(screen.getByRole('list', { name: 'Recent skills' })).getAllByRole('listitem');
    expect(skills[0]!.textContent).toContain('Ship it');
    expect(skills[0]!.textContent).toContain('gen 3');
    expect(within(skills[0]!).getByRole('link').getAttribute('href')).toBe('/p/x/skills/sk1');
    expect(screen.getByRole('link', { name: /All sessions/ }).getAttribute('href')).toBe('/p/x/sessions');
  });

  it('keeps the name and the archived banner above the activity read, says why runs and skills are empty without a provider, and says when a panel could not load', async () => {
    server(base({
      '/api/projects': () => Response.json({ projects: [{ ...PROJECTS.projects[0], archivedAt: NOW - 500, archivedBy: 'mem_1' }] }),
      '/api/projects/x/activity': () => Response.json({ items: [], stats: { sessions: 1, openSessions: 0, sessionsLast7d: 0, prompts: 0, toolCalls: 0, plans: 0, attachments: 0, lastActivityAt: NOW - 1000 } }),
      '/api/projects/x/sessions?limit=50&state=open': () => page([]),
      '/api/projects/x/runs?limit=50': () => page([]),
      '/api/projects/x/skills?limit=200': () => new Response(null, { status: 500 }),
      '/api/agents': () => Response.json({ agents: [{ id: 'a', name: 'Default', provider: null, model: null, enabled: false }] }),
    }));
    mount('/p/x');
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Project X');
    expect(await screen.findByTestId('archived-banner')).toBeTruthy();
    expect((await screen.findByText(/No runs yet — no provider is configured/)).textContent).toContain('Configure one in Settings');
    expect(await screen.findByText('Could not load the skills.')).toBeTruthy();
  });

  it('says the capture has gone quiet when the last session landed over a week ago', async () => {
    server(base({ '/api/projects/x/activity': () => Response.json({ items: [], stats: { sessions: 2, openSessions: 0, sessionsLast7d: 0, prompts: 1, toolCalls: 1, plans: 0, attachments: 0, lastActivityAt: NOW - 9 * 24 * 3_600_000 } }) }));
    mount('/p/x');
    expect((await screen.findByTestId('capture-health')).textContent).toMatch(/^No capture in 7 days · last /);
    expect(screen.getByTestId('activity-line').textContent).toBe('Quiet right now — nothing running.');
  });

  it('shows a project that has captured nothing as empty', async () => {
    server(base({ '/api/projects/x/activity': () => Response.json({ items: [], stats: { sessions: 0, openSessions: 0, sessionsLast7d: 0, prompts: 0, toolCalls: 0, plans: 0, attachments: 0, lastActivityAt: null } }) }));
    mount('/p/x');
    expect(await screen.findByText('Nothing captured yet.')).toBeTruthy();
  });
});
