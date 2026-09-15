import { expect } from 'bun:test';
import { expectPersisted, lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

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
    const post = async (kind: string, createdAt: number, payload: Record<string, unknown>) => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind, createdAt, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      await expectPersisted(res, kind);
    };
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
    expect(await target.sql(`SELECT ended_by AS endedBy FROM sessions WHERE session_id = ${lit(session)}`)).toEqual([{ endedBy: MEMBER_ID }]);
    expect(await end()).toEqual({ outcome: 'already_ended', endedAt: first.endedAt });

    // A newer live turn reopens; an older hook end delivered afterwards is left unapplied.
    await post('prompt', first.endedAt + 1_000, { promptId: crypto.randomUUID(), text: `Back at it ${stamp}`, origin: 'user' });
    expect((await listed())?.endedAt).toBeNull();
    expect(await mcpStatus()).toBe('active');
    await post('session.end', first.endedAt + 500, { endedAt: first.endedAt + 500 });
    expect((await listed())?.endedAt).toBeNull();
    await post('session.end', first.endedAt + 2_000, { endedAt: first.endedAt + 2_000 });
    expect((await listed())?.endedAt).toBe(first.endedAt + 2_000);
    expect(await target.sql(`SELECT ended_by AS endedBy FROM sessions WHERE session_id = ${lit(session)}`)).toEqual([{ endedBy: null }]);
  },
};
