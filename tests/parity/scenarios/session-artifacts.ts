import { expect } from 'bun:test';
import { lit, expectPersisted, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * What a session reported it created, on both targets: a session started through /events, a pull request reported
 * through `myco_outcomes` and reported again unchanged, the same artifact under another URL refused, the session
 * page's read serving it, and a deleted session refusing a report and losing the one it held. The page read plans
 * over the session index on each store.
 */
export const sessionArtifactsParity: ParityScenario = {
  name: 'session artifacts: declared report, idempotent re-report, conflict refusal, deletion, index-backed page read',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const session = `parity-artifacts-${stamp}`;
    const url = 'https://github.com/goondocks-co/myco/pull/1931';
    const res = await fetch(`${target.url}/events`, {
      method: 'POST',
      headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind: 'session.start', createdAt: stamp, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload: { agent: 'claude-code', startedAt: stamp } }),
    });
    await expectPersisted(res, 'session.start');
    const call = async (args: Record<string, unknown>) => {
      const answer = await fetch(`${target.url}/mcp`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_outcomes', arguments: { project: target.projectId, ...args } } }),
      });
      return ((await answer.json()) as { result?: { structuredContent: { result: any } } }).result?.structuredContent.result;
    };
    const report = { op: 'report', session_id: session, kind: 'pr', artifact_id: '1931', url };
    const page = async () => {
      const read = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${session}/artifacts`, { headers: target.ownerHeaders() });
      return { status: read.status, body: read.status === 200 ? await read.json() as { rows: Array<Record<string, unknown>>; cursor: string | null } : null };
    };

    const first = await call(report);
    expect(first).toMatchObject({ kind: 'pr', artifact_id: '1931', url, linked: true, session_id: session, created: true });
    expect(await call(report)).toEqual({ ...first, created: false });
    expect(await call({ ...report, url: `${url}9` })).toEqual({ ok: false, error: 'this artifact was already reported for this session with a different url' });
    expect(await page()).toEqual({ status: 200, body: { rows: [{ id: first.id, kind: 'pr', artifactId: '1931', url, linked: true, reportedAt: first.reported_at }], cursor: null } });

    const plan = (await target.sql(`EXPLAIN QUERY PLAN SELECT id FROM session_artifacts WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(session)}
      AND (reported_at > 0 OR (reported_at = 0 AND id > 'a')) ORDER BY reported_at, id LIMIT 51`)).map((row) => String(row.detail)).join('\n');
    console.info(`[${target.name}] session artifacts plan:\n${plan}`);
    expect(plan).toMatch(/SEARCH session_artifacts USING (COVERING )?INDEX idx_session_artifacts_session \(project_id=\? AND session_id=\?/);
    expect(plan).not.toMatch(/\bSCAN\b|TEMP B-TREE/);

    const gone = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${session}/tombstone`, {
      method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'parity' }),
    });
    expect(gone.status).toBe(200);
    expect(await call({ ...report, artifact_id: '1932' })).toEqual({ ok: false, error: 'session_id not found' });
    expect(await target.sql(`SELECT COUNT(*) AS n FROM session_artifacts WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(session)}`)).toEqual([{ n: 0 }]);
    expect((await page()).status).toBe(404);
  },
};
