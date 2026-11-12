import { expect } from 'bun:test';
import { expectPersisted, type ParityScenario, type ParityTarget } from '../harness.ts';
import { sessionDetail, untilPublished } from '../clients/requests.ts';

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
    const before = await projectOrEmpty();
    const res = await fetch(`${target.url}/events`, {
      method: 'POST',
      headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind: 'session.start', createdAt: stamp, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload: { agent: 'claude-code', startedAt: stamp } }),
    });
    await expectPersisted(res, 'session.start');
    const added = await untilPublished(target, async () => ({ row: await project(), stats: await railTotal(), session: await sessionDetail(target, session) }),
      (read) => read.row.sessionCount === before.sessionCount + 1 && read.row.sessionCount === read.stats && read.session.status === 200 && read.row.lastActivityAt === read.session.body.session.lastReceivedAt);
    expect(added.row.sessionCount).toBe(before.sessionCount + 1);
    expect(added.row.sessionCount).toBe(added.stats);
    const receiptAt = added.session.body.session.lastReceivedAt as number;
    expect(added.row.lastActivityAt).toBe(receiptAt);

    const gone = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${session}/tombstone`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'parity' }) });
    expect(gone.status).toBe(202);
    const after = await untilPublished(target, async () => ({ row: await project(), stats: await railTotal() }),
      (read) => read.row.sessionCount === before.sessionCount && read.row.sessionCount === read.stats);
    expect(after.row.sessionCount).toBe(before.sessionCount);
    expect(after.row.sessionCount).toBe(after.stats);
    expect(after.row.lastActivityAt === null || after.row.lastActivityAt < receiptAt).toBe(true);
  },
};
