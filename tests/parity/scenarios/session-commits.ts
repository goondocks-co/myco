import { expect } from 'bun:test';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sessionCommits } from '@myco-server-worker/read/session-commits.js';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** The statements `sessionCommits` prepares, with the values bound to each, from a store that answers nothing. */
async function issued(projectId: string, sessionId: string): Promise<Array<{ sql: string; binds: unknown[] }>> {
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string): PreparedStatement {
      const record = { sql, binds: [] as unknown[] };
      statements.push(record);
      const statement = {
        bind(...values: unknown[]) { record.binds = values; return statement; },
        first: async () => null,
        all: async () => ({ results: [] }),
      } as unknown as PreparedStatement;
      return statement;
    },
  } as unknown as RelationalStore;
  await sessionCommits(db, { projectId }, sessionId);
  return statements;
}

/**
 * A session's commit observations on both targets: the start and end commits
 * captured through /events, a release state recorded from the end, and the
 * same state answered as covering an earlier end once a later end arrives with
 * uncommitted changes. Both reads plan over an index on each store.
 */
export const sessionCommitsParity: ParityScenario = {
  name: 'session commits: start and end observations, release containment on the end it classified, index-backed reads',
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
    expect(await commits()).toEqual({ observations: [{ point: 'session_start', headSha: A, branch: 'main', changes: 'none', capturedAt: stamp }], release: null });

    await post('session.end', stamp + 10, { endedAt: stamp + 10, headSha: B, dirty: false });
    await target.sql(`INSERT INTO knowledge_release_state (project_id, id, identity_key, namespace, record_id, source_session_id, state, confidence,
        basis_kind, basis_ref, basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
      VALUES (${lit(target.projectId)}, ${lit(`rs_${stamp}`)}, ${lit(`${target.projectId}:sessions:${session}`)}, 'sessions', ${lit(session)}, ${lit(session)},
        'released', 'high', 'github_pr_squash', 'refs/tags/v1.0.0', ${lit('d'.repeat(40))}, 12, 'r',
        ${lit(JSON.stringify({ source: `session_end:${B}:0` }))}, ${stamp + 20}, ${stamp + 20})`);
    const release = { state: 'released', basisKind: 'github_pr_squash', basisRef: 'refs/tags/v1.0.0', releasePrNumber: 12, checkedAt: stamp + 20 };
    expect(await commits()).toEqual({
      observations: [
        { point: 'session_start', headSha: A, branch: 'main', changes: 'none', capturedAt: stamp },
        { point: 'session_end', headSha: B, branch: 'main', changes: 'none', capturedAt: stamp + 10 },
      ],
      release: { ...release, covers: { point: 'session_end', current: true } },
    });

    await post('session.end', stamp + 30, { endedAt: stamp + 30, headSha: B, dirty: true });
    const later = await commits();
    expect(later.observations[1]).toEqual({ point: 'session_end', headSha: B, branch: 'main', changes: 'uncommitted', capturedAt: stamp + 30 });
    expect(later.release).toEqual({ ...release, covers: { point: 'session_end', current: false } });

    const statements = await issued(target.projectId, session);
    expect(statements).toHaveLength(2);
    const plans: string[] = [];
    for (const { sql, binds } of statements) {
      let next = 0;
      const inlined = sql.replace(/\?/g, () => {
        const value = binds[next++];
        return typeof value === 'number' ? String(value) : lit(String(value));
      });
      plans.push((await target.sql(`EXPLAIN QUERY PLAN ${inlined}`)).map((row) => String(row.detail)).join('\n'));
    }
    console.info(`[${target.name}] session commits plans:\n${plans.join('\n---\n')}`);
    expect(plans[0]).toMatch(/SEARCH g USING INDEX idx_fk_knowledge_git_provenance_project_id_session_id \(project_id=\? AND session_id=\?\)/);
    expect(plans[1]).toMatch(/SEARCH knowledge_release_state USING INDEX idx_knowledge_release_embedding/);
    for (const plan of plans) expect(plan).not.toMatch(/\bSCAN\b/);
  },
};
