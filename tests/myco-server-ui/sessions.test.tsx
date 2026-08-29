import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris' } };
const PROJECTS = { projects: [{ projectId: 'x', name: 'Project X', createdAt: 0, sessionCount: 2, lastActivityAt: null }] };
const NOW = Date.now();
const KEY_TEXT = 'a'.repeat(64);
const KEY_IMG = 'b'.repeat(64);
const KEY_SVG = 'c'.repeat(64);
const KEY_SEG = 'd'.repeat(64);
const BLOB = (key: string) => `/api/projects/x/blobs/${key}`;

const session = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1', machineId: 'mac-1', createdByTokenId: 'tok_1', firstReceivedAt: NOW - 3_600_000, lastReceivedAt: NOW - 60_000,
  agent: 'claude-code', branch: 'main', startedAt: NOW - 3_600_000, endedAt: null, originPath: '/repo', parentSessionId: null, parentReason: null,
  memberId: 'mem_1', memberLabel: 'chris', runtimeLabel: 'laptop', runtimeKind: 'host', ...over,
});
const page = (rows: unknown[]) => Response.json({ rows, cursor: null });
const counts = { prompts: 1, toolCalls: 1, responses: 1, plans: 0, attachments: 2 };

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(routes: Record<string, () => Response>): { requested: string[] } {
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(href, 'https://s').pathname;
    requested.push(pathname);
    return routes[pathname]?.() ?? new Response(null, { status: 404 });
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
    server(base({ '/api/projects/x/sessions': () => page([session(), session({ sessionId: 's2', agent: 'codex', branch: 'fix', endedAt: NOW - 1000, memberLabel: null, memberId: null, runtimeLabel: null })]) }));
    mount('/p/x/sessions');
    const rows = await screen.findAllByRole('row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('claude-code'),
      expect.stringContaining('codex'),
    ]);
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
    '/api/projects/x/sessions/s1/prompts': () => page([{ promptId: 'p1', text: null, blobKey: KEY_TEXT, origin: 'user', promptKind: null, parentPromptId: null, threadLabel: null, createdAt: NOW - 3000, orderedAt: NOW - 3000 }]),
    '/api/projects/x/sessions/s1/tool-calls': () => page([{ toolCallId: 't1', promptId: 'p1', toolName: 'Write', mycoTool: null, mycoOp: null, inputPreview: 'x'.repeat(20), inputBytes: 190_000, inputBlobKey: null, outputPreview: 'wrote it', outputBlobKey: null, success: false, errorMessage: 'disk full', durationMs: 42, filesAffected: null, createdAt: NOW - 2000, orderedAt: NOW - 2000 }]),
    '/api/projects/x/sessions/s1/responses': () => page([{ responseId: 'r1', promptId: 'p1', text: 'done', blobKey: null, createdAt: NOW - 1000, orderedAt: NOW - 1000 }]),
    '/api/projects/x/sessions/s1/plans': () => page([]),
    '/api/projects/x/sessions/s1/attachments': () => page([
      { attachmentId: 'a1', blobKey: KEY_IMG, mediaType: 'image/png', byteSize: 1234, description: 'a screenshot', createdAt: NOW, orderedAt: NOW },
      { attachmentId: 'a2', blobKey: KEY_SVG, mediaType: 'image/svg+xml', byteSize: 99, description: 'a diagram', createdAt: NOW, orderedAt: NOW },
    ]),
    '/api/projects/x/sessions/s1/transcript': () => Response.json({
      transcript: { transcriptId: 'tx1', sessionId: 's1', machineId: 'mac-1', agent: 'claude-code', originPath: '/repo', size: 7_340_032, segmentCount: 2, firstReceivedAt: NOW - 3000, lastReceivedAt: NOW },
      segments: [{ baseOffset: 0, length: 4_000_000, blobKey: KEY_SEG, createdAt: NOW - 3000 }, { baseOffset: 4_000_000, length: 3_340_032, blobKey: KEY_SEG, createdAt: NOW }],
    }),
    [BLOB(KEY_TEXT)]: () => new Response('{"a":1}', { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    ...over,
  });

  it('renders spilled prompt text from its blob verbatim — never a blank bubble — and the conversation in order', async () => {
    const { requested } = server(detailRoutes());
    mount('/p/x/sessions/s1');
    expect(await screen.findByText('{"a":1}')).toBeTruthy();
    expect(screen.getByText('disk full')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText(/Input · 186 KB/)).toBeTruthy();
    const bubbles = screen.getAllByTestId(/^bubble-/).map((b) => b.getAttribute('data-testid'));
    expect(bubbles).toEqual(['bubble-prompt', 'bubble-tool', 'bubble-response']);
    expect(requested.filter((p) => p.startsWith('/api/projects/x/blobs/'))).toEqual([BLOB(KEY_TEXT)]);
    expect(screen.getByText('chris')).toBeTruthy();
    expect(screen.getByText('laptop · mac-1')).toBeTruthy();
  });

  it('renders an image attachment inline only for the renderable types, and links the rest', async () => {
    server(detailRoutes());
    mount('/p/x/sessions/s1');
    fireEvent.click(await screen.findByRole('tab', { name: 'Attachments' }));
    const img = await screen.findByRole('img', { name: 'a screenshot' });
    expect(img.getAttribute('src')).toBe(BLOB(KEY_IMG));
    expect(screen.queryByRole('img', { name: 'a diagram' })).toBeNull();
    expect(screen.getByText('Download a diagram').getAttribute('href')).toBe(BLOB(KEY_SVG));
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
