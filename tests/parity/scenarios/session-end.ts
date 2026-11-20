import { context } from '../clients/capture.ts';
import { expect } from 'bun:test';
import { MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';
import { event, owner } from '../clients/requests.ts';

/**
 * A person's end of a session on both targets: the owner route ends an open
 * session and every reader agrees; a newer live turn reopens it; an older end
 * that arrives afterwards leaves it open; a repeat end is a no-op.
 */
export const sessionEnd: ParityScenario = {
  name: 'session end: a person ends an open session, a newer live turn reopens it, an older end after that is left unapplied',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const session = `parity-end-${stamp}`;
    const post = (kind: string, createdAt: number, payload: Record<string, unknown>) => event(target, session, kind, payload, createdAt);
    const end = async () => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${session}/end`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
      return await res.json() as { outcome: string; endedAt: number | null };
    };
    const listed = async () => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/sessions`, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      return ((await res.json()) as { rows: Array<{ sessionId: string; endedAt: number | null }> }).rows.find((row) => row.sessionId === session);
    };
    const mcpStatus = async () => {
      const res = await fetch(`${target.url}/mcp`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_sessions', arguments: { op: 'get', id: session } } }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { result: { structuredContent: { result: { status: string } } } }).result.structuredContent.result.status;
    };

    await post('session.start', stamp - 60_000, { agent: 'claude-code', startedAt: stamp - 60_000 });
    await post('prompt', stamp - 50_000, { promptId: crypto.randomUUID(), text: `Wire the end ${stamp}`, origin: 'user' });
    expect((await listed())?.endedAt).toBeNull();

    const first = await end() as { outcome: string; endedAt: number };
    expect(first.outcome).toBe('ended');
    expect((await listed())?.endedAt).toBe(first.endedAt);
    expect(await mcpStatus()).toBe('completed');
    const endedBy = async () => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${session}`, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      return ((await res.json()) as { session: { endedBy: string | null } }).session.endedBy;
    };
    expect(await endedBy()).toBe(MEMBER_ID);
    expect(await end()).toEqual({ outcome: 'already_ended', endedAt: first.endedAt });

    // A newer live turn reopens; an older hook end delivered afterwards is left unapplied.
    await post('prompt', first.endedAt + 1_000, { promptId: crypto.randomUUID(), text: `Back at it ${stamp}`, origin: 'user' });
    expect((await listed())?.endedAt).toBeNull();
    expect(await mcpStatus()).toBe('active');
    await post('session.end', first.endedAt + 500, { endedAt: first.endedAt + 500 });
    expect((await listed())?.endedAt).toBeNull();
    await post('session.end', first.endedAt + 2_000, { endedAt: first.endedAt + 2_000 });
    expect((await listed())?.endedAt).toBe(first.endedAt + 2_000);
    expect(await endedBy()).toBeNull();
  },
};

export const sessionActivity: ParityScenario = {
  name: 'session activity: late capture stays ended, empty sessions disappear only after going quiet, and future clocks are bounded',
  async run(target) {
    const now = Date.now(), day = 86_400_000;
    const late = `late-${now}`, empty = `empty-${now}`, future = `future-${now}`;
    const list = async () => (await owner(target, `/api/projects/${target.projectId}/sessions`)).body.rows;
    await event(target, late, 'session.start', { agent: 'claude-code', startedAt: now - day }, now - day);
    await event(target, late, 'prompt', { promptId: crypto.randomUUID(), text: 'Yesterday work', origin: 'user' }, now - day);
    expect((await list()).find((row: any) => row.sessionId === late)).toMatchObject({ live: false, liveUntil: null });
    await event(target, empty, 'session.start', { agent: 'claude-code' });
    expect((await list()).find((row: any) => row.sessionId === empty)).toMatchObject({ live: true });
    await event(target, empty, 'session.end', {});
    expect((await list()).some((row: any) => row.sessionId === empty)).toBe(false);
    await event(target, future, 'session.start', { agent: 'claude-code' });
    const before = (await list()).find((row: any) => row.sessionId === future).liveUntil;
    await event(target, future, 'prompt', { promptId: crypto.randomUUID(), text: 'Clock ahead', origin: 'user' }, now + 120_000);
    const row = (await list()).find((row: any) => row.sessionId === future);
    expect(row.live).toBe(true);
    expect(row.liveUntil - before).toBeLessThan(60_000);
    const working = `working-${now}`;
    await event(target, working, 'session.start', { agent: 'claude-code' }, now - 2 * 3_600_000);
    await context(target, 'prompt', { sessionId: working, promptId: crypto.randomUUID(), text: 'Working on the first turn', identity: 1, at: Date.now() });
    expect((await owner(target, '/api/sessions')).body.rows.find((row: any) => row.sessionId === working)).toMatchObject({ working: true, live: false });
    await event(target, working, 'session.end', {});
    expect((await list()).some((row: any) => row.sessionId === working)).toBe(false);
  },
};
