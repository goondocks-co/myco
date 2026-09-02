import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

describe('Sessions list', () => {
  it('shows each session with its agent, branch, member and runtime, open or ended, and filters client-side', async () => {
    server(base({ '/api/projects/x/sessions': () => page([session({ title: 'Wave-based executor', label: 'Wave-based executor' }), session({ sessionId: 's2', agent: 'codex', branch: 'fix', endedAt: NOW - 1000, memberLabel: null, memberId: null, runtimeLabel: null, label: 'Fix the flaky test…' })]) }));
    mount('/p/x/sessions');
    const rows = await screen.findAllByRole('row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Wave-based executor'),
      expect.stringContaining('Fix the flaky test…'),
    ]);
    expect(rows[0]!.textContent).toContain('claude-code');
    expect(rows[1]!.textContent).toContain('codex');
    expect(rows[0]!.textContent).toContain('chris');
    expect(rows[0]!.textContent).toContain('laptop · mac-1');
    expect(rows[0]!.textContent).toContain('last ');
    expect(rows[1]!.textContent).toContain('tok_1');
    expect(rows[1]!.textContent).toContain('host · mac-1');
    expect(rows[1]!.textContent).toContain('ended ');
    fireEvent.click(screen.getByRole('tab', { name: 'Ended' }));
    expect(screen.getAllByRole('row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'fix' } });
    expect(screen.getAllByRole('row').map((r) => r.textContent)).toEqual([expect.stringContaining('codex')]);
    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'nothing-here' } });
    expect(screen.getByText('No sessions match.')).toBeTruthy();
  });

  it('shows a project with no sessions as empty, not missing', async () => {
    server(base({ '/api/projects/x/sessions': () => page([]) }));
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
  });

  it('shows a project that has captured nothing as empty', async () => {
    server(base({ '/api/projects/x/activity': () => Response.json({ items: [], stats: { sessions: 0, openSessions: 0, sessionsLast7d: 0, prompts: 0, toolCalls: 0, plans: 0, attachments: 0, lastActivityAt: null } }) }));
    mount('/p/x');
    expect(await screen.findByText('Nothing captured yet.')).toBeTruthy();
  });
});
