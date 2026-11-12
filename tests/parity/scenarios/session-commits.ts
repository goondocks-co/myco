import { expect } from 'bun:test';
import { expectPersisted, type ParityScenario, type ParityTarget } from '../harness.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** Commit observations captured by the member reach the session's commit view. */
export const sessionCommitsParity: ParityScenario = {
  name: 'session commits: start and end observations, including later uncommitted changes',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const session = `parity-commits-${stamp}`;
    const post = async (kind: string, createdAt: number, payload: Record<string, unknown>) => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind, createdAt, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      await expectPersisted(res, kind);
    };
    const commits = async () => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${session}/commits`, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      return await res.json() as { observations: Array<Record<string, unknown>>; release: Record<string, unknown> | null };
    };

    await post('session.start', stamp, { agent: 'claude-code', branch: 'main', headSha: A, startedAt: stamp });
    expect(await commits()).toEqual({ observations: [{ point: 'session_start', headSha: A, branch: 'main', changes: 'unreadable', capturedAt: stamp }], release: null });

    await post('session.end', stamp + 10, { endedAt: stamp + 10, headSha: B, dirty: false });
    expect(await commits()).toEqual({
      observations: [
        { point: 'session_start', headSha: A, branch: 'main', changes: 'unreadable', capturedAt: stamp },
        { point: 'session_end', headSha: B, branch: 'main', changes: 'none', capturedAt: stamp + 10 },
      ],
      release: null,
    });

    await post('session.end', stamp + 30, { endedAt: stamp + 30, headSha: B, dirty: true });
    const later = await commits();
    expect(later.observations[1]).toEqual({ point: 'session_end', headSha: B, branch: 'main', changes: 'uncommitted', capturedAt: stamp + 30 });
    expect(later.release).toBeNull();
  },
};
