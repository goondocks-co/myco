import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * A deleted session leaves the project list on both targets: the project's
 * session count and latest activity come from live sessions only, the project
 * itself stays listed, and the count agrees with the project's own statistics.
 */
export const projectCounts: ParityScenario = {
  name: 'project counts: a deleted session is out of the project list count and latest activity while the project stays listed',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const session = `parity-count-${stamp}`;
    const project = async () => {
      const res = await fetch(`${target.url}/api/projects`, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      const row = ((await res.json()) as { projects: Array<{ projectId: string; sessionCount: number; lastActivityAt: number | null }> }).projects.find((p) => p.projectId === target.projectId);
      expect(row).toBeDefined();
      return row!;
    };
    // The project row appears with its first ingested event; before that the list has no entry for it.
    const projectOrEmpty = async () => {
      const res = await fetch(`${target.url}/api/projects`, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      const row = ((await res.json()) as { projects: Array<{ projectId: string; sessionCount: number }> }).projects.find((p) => p.projectId === target.projectId);
      return row ?? { sessionCount: 0 };
    };
    const railTotal = async () => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/activity`, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      return ((await res.json()) as { stats: { sessions: number } }).stats.sessions;
    };
    const liveCount = async () => {
      const rows = await target.sql(`SELECT COUNT(*) AS n FROM sessions s WHERE s.project_id = ${lit(target.projectId)} AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = s.project_id AND t.session_id = s.session_id)`);
      return Number(rows[0]!.n);
    };

    const before = await projectOrEmpty();
    const res = await fetch(`${target.url}/events`, {
      method: 'POST',
      headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind: 'session.start', createdAt: stamp, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload: { agent: 'claude-code', startedAt: stamp } }),
    });
    await expectPersisted(res, 'session.start');
    const added = await project();
    expect(added.sessionCount).toBe(before.sessionCount + 1);
    expect(added.sessionCount).toBe(await liveCount());
    const [receipt] = await target.sql(`SELECT last_received_at AS at FROM sessions WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(session)}`);
    expect(added.lastActivityAt).toBe(Number(receipt!.at));

    const gone = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${session}/tombstone`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'parity' }) });
    expect(gone.status).toBe(200);
    const after = await project();
    expect(after.sessionCount).toBe(before.sessionCount);
    expect(after.sessionCount).toBe(await liveCount());
    expect(after.sessionCount).toBe(await railTotal());
    expect(after.lastActivityAt === null || after.lastActivityAt < Number(receipt!.at)).toBe(true);
  },
};
