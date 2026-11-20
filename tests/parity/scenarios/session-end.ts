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
  name: 'session activity: request clocks distinguish live work from late capture while older members retain receipt-time liveness',
  async run(target) {
    const now = Date.now(), hour = 3_600_000, day = 24 * hour;
    const list = async () => (await owner(target, `/api/projects/${target.projectId}/sessions`)).body.rows;
    for (const [name, age, skew, live] of [
      ['slow-three-hours', 0, -3 * hour, true], ['fast-three-hours', -120_000, 3 * hour, true],
      ['slow-day', 0, -day, true], ['late', day, 0, false], ['late-slow-day', day, -day, false],
      ['older-member', day, null, true],
    ] as const) {
      const id = `${name}-${now}`;
      await event(target, id, 'prompt', { promptId: crypto.randomUUID(), text: 'Captured work', origin: 'user' }, now - age + (skew ?? 0), target.projectId, skew === null ? {} : { sentAt: now + skew });
      const row = (await list()).find((row: any) => row.sessionId === id);
      expect(row).toMatchObject({ live });
      if (name === 'fast-three-hours') {
        await event(target, id, 'prompt', { promptId: crypto.randomUUID(), text: 'Older work', origin: 'user' }, now - day + skew, target.projectId, { sentAt: now + skew });
        expect((await list()).find((row: any) => row.sessionId === id).liveUntil).toBe(row.liveUntil);
      }
    }
    const rows = await list();
    expect(rows.find((row: any) => row.sessionId === `fast-three-hours-${now}`).liveUntil).toBeLessThanOrEqual(rows.find((row: any) => row.sessionId === `older-member-${now}`).liveUntil);
    const empty = `empty-${now}`;
    await event(target, empty, 'session.start', { agent: 'codex' });
    await event(target, empty, 'session.end', {});
    expect((await list()).find((row: any) => row.sessionId === empty)).toMatchObject({ live: false });
  },
};
