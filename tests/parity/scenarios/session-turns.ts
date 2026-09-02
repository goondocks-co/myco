import { expect } from 'bun:test';
import type { ParityScenario, ParityTarget } from '../harness.ts';

const UUID = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A one-pixel PNG, enough to be stored under an image type. */
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 167, 53, 129, 132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

/**
 * The session page's reads on both targets: a session captured through /events
 * with a person's prompt, a system prompt, a steering child, tool calls and
 * responses keyed to their prompts, and an attachment — read back as turns, one
 * turn's body, one turn's tool calls, and the rail's summaries and filters.
 */
export const sessionTurns: ParityScenario = {
  name: 'session turns: capture keyed to prompts, turns read, turn body, tool calls on their own, rail summaries and filters',
  async run(target: ParityTarget) {
    const post = async (sessionId: string, kind: string, payload: Record<string, unknown>) => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt: Date.now(), channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      expect(`${kind} ${res.status}`).toBe(`${kind} 200`);
    };
    const owner = async <T,>(path: string): Promise<{ status: number; body: T }> => {
      const res = await fetch(`${target.url}${path}`, { headers: target.ownerHeaders() });
      return { status: res.status, body: (await res.json()) as T };
    };

    const key = await sha256Hex(PNG);
    const blob = await fetch(`${target.url}/blobs/${key}`, {
      method: 'POST',
      headers: { ...target.memberHeaders(), 'content-type': 'image/png', 'content-length': String(PNG.byteLength) },
      body: PNG,
    });
    expect(`blob ${blob.status}`).toMatch(/^blob 20[01]$/);

    const stamp = Date.now();
    const session = `parity-turns-${stamp}`;
    const [p1, p2, p3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await post(session, 'session.start', { agent: 'claude-code', branch: 'turns', startedAt: stamp });
    await post(session, 'prompt', { promptId: p1, text: `Please rename the project card ${stamp}`, origin: 'user' });
    await post(session, 'tool.use', { toolCallId: UUID(1), promptId: p1, toolName: 'Read', input: { file_path: 'a.ts' }, output: 'the file', success: true });
    await post(session, 'tool.failure', { toolCallId: UUID(2), promptId: p1, toolName: 'Bash', input: { command: 'false' }, success: false, errorMessage: 'exit 1' });
    await post(session, 'attachment', { attachmentId: UUID(3), promptId: p1, blob: key, description: 'a screenshot' });
    await post(session, 'response', { responseId: UUID(4), promptId: p1, text: 'Renamed it.' });
    await post(session, 'prompt', { promptId: p2, text: '<system-reminder>not typed by a person</system-reminder>', origin: 'system' });
    await post(session, 'prompt', { promptId: p3, text: 'steer: use the other card', origin: 'user', parentPromptId: p1, threadLabel: 'reviewer' });
    await post(session, 'tool.use', { toolCallId: UUID(5), promptId: p3, toolName: 'Edit', input: { file_path: 'b.ts' }, success: true });
    await post(session, 'response', { responseId: UUID(6), promptId: p3, text: 'Used the other card.' });

    const base = `/api/projects/${target.projectId}/sessions/${session}`;
    interface TurnRow { promptId: string; origin: string; preview: string | null; toolCallCount: number; responseCount: number; childCount: number }
    const turns = await owner<{ rows: TurnRow[]; cursor: string | null }>(`${base}/turns`);
    expect(turns.status).toBe(200);
    expect(turns.body.rows.map((r) => [r.promptId, r.origin, r.toolCallCount, r.responseCount, r.childCount])).toEqual([[p1, 'user', 2, 1, 1]]);
    expect(turns.body.rows[0].preview).toContain('rename the project card');

    const all = await owner<{ rows: TurnRow[] }>(`${base}/turns?origins=user,system,agent_dispatch,hook_injected,unknown`);
    expect(all.body.rows.map((r) => [r.promptId, r.origin])).toEqual([[p1, 'user'], [p2, 'system']]);
    expect((await owner(`${base}/turns?origins=human`)).status).toBe(400);

    interface Detail { prompt: { promptId: string; text: string | null }; responses: { text: string | null }[]; attachments: { attachmentId: string; promptId: string | null; blobKey: string; mediaType: string }[]; children: { prompt: { promptId: string; threadLabel: string | null }; toolCallCount: number; responses: { text: string | null }[] }[] }
    const detail = await owner<Detail>(`${base}/turns/${p1}`);
    expect(detail.status).toBe(200);
    expect(detail.body.prompt.text).toContain('rename the project card');
    expect(detail.body.responses.map((r) => r.text)).toEqual(['Renamed it.']);
    expect(detail.body.attachments.map((a) => [a.attachmentId, a.promptId, a.blobKey, a.mediaType])).toEqual([[UUID(3), p1, key, 'image/png']]);
    expect(detail.body.children.map((c) => [c.prompt.promptId, c.prompt.threadLabel, c.toolCallCount, c.responses.map((r) => r.text)])).toEqual([[p3, 'reviewer', 1, ['Used the other card.']]]);

    const calls = await owner<{ rows: { toolCallId: string; toolName: string; success: boolean; errorMessage: string | null; outputPreview: string | null }[] }>(`${base}/turns/${p1}/tool-calls`);
    expect(calls.body.rows.map((t) => [t.toolCallId, t.toolName, t.success, t.errorMessage, t.outputPreview])).toEqual([[UUID(1), 'Read', true, null, 'the file'], [UUID(2), 'Bash', false, 'exit 1', null]]);
    expect((await owner<{ rows: unknown[] }>(`${base}/turns/${p2}/tool-calls`)).body.rows).toEqual([]);

    interface SummaryRow { sessionId: string; promptCount: number; toolCallCount: number; activityBuckets: number[]; label: string }
    const list = async (query: string) => (await owner<{ rows: SummaryRow[] }>(`/api/projects/${target.projectId}/sessions${query}`)).body.rows;
    const mine = (await list('')).find((r) => r.sessionId === session);
    expect(mine).toBeDefined();
    expect([mine!.promptCount, mine!.toolCallCount, mine!.activityBuckets.length, mine!.activityBuckets.reduce((a, b) => a + b, 0)]).toEqual([3, 3, 8, 3]);
    expect((await list(`?q=${encodeURIComponent(`card ${stamp}`)}`)).map((r) => r.sessionId)).toEqual([session]);
    expect((await list('?state=open&branch=turns')).some((r) => r.sessionId === session)).toBe(true);
    await post(session, 'session.end', { endedAt: Date.now() });
    expect((await list('?state=open&branch=turns')).some((r) => r.sessionId === session)).toBe(false);
    expect((await list('?state=ended&branch=turns')).some((r) => r.sessionId === session)).toBe(true);
  },
};
